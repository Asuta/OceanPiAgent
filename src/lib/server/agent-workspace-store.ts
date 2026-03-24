import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RoomAgentId } from "@/lib/chat/types";

export interface AgentWorkspaceEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  size: number;
  updatedAt: string;
}

export interface AgentWorkspaceListResult {
  workspaceRoot: string;
  targetPath: string;
  recursive: boolean;
  truncated: boolean;
  entries: AgentWorkspaceEntry[];
}

export interface AgentWorkspaceReadResult {
  workspaceRoot: string;
  path: string;
  fromLine: number;
  lineCount: number;
  updatedAt: string;
  text: string;
}

export interface AgentWorkspaceWriteResult {
  workspaceRoot: string;
  path: string;
  bytesWritten: number;
  updatedAt: string;
}

export interface AgentWorkspaceAppendResult {
  workspaceRoot: string;
  path: string;
  bytesAppended: number;
  updatedAt: string;
}

export interface AgentWorkspaceMoveResult {
  workspaceRoot: string;
  fromPath: string;
  toPath: string;
  movedType: "file" | "directory";
  updatedAt: string;
}

export interface AgentWorkspaceMkdirResult {
  workspaceRoot: string;
  path: string;
  created: boolean;
  updatedAt: string;
}

export interface AgentWorkspaceDeleteResult {
  workspaceRoot: string;
  path: string;
  deletedType: "file" | "directory";
  recursive: boolean;
}

const WORKSPACE_ROOT = path.join(process.cwd(), ".oceanking", "workspaces");
const SHARED_WORKSPACE_DIR = path.join(WORKSPACE_ROOT, "_shared");
const DEFAULT_READ_LINE_COUNT = 200;
const MAX_READ_LINE_COUNT = 400;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;
const ALLOW_OUTSIDE_WORKSPACE_ENV = "OCEANKING_AGENT_WORKSPACE_ALLOW_OUTSIDE";

interface ResolvedWorkspacePath {
  workspaceRoot: string;
  resolvedPath: string;
  displayPath: string;
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value || "").trim());
}

function normalizeForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const normalizedParent = normalizeForComparison(parentPath);
  const normalizedChild = normalizeForComparison(childPath);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
}

function getWorkspaceRootPath(): string {
  return WORKSPACE_ROOT;
}

export function getAgentWorkspaceDir(agentId: RoomAgentId): string {
  return path.join(getWorkspaceRootPath(), agentId);
}

export function getSharedWorkspaceDir(): string {
  return SHARED_WORKSPACE_DIR;
}

export function isAgentWorkspaceOutsideAccessEnabled(): boolean {
  return isTruthyEnv(process.env[ALLOW_OUTSIDE_WORKSPACE_ENV]);
}

async function ensureDir(dirPath: string): Promise<string> {
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

async function ensureWorkspaceDir(agentId: RoomAgentId): Promise<string> {
  return ensureDir(getAgentWorkspaceDir(agentId));
}

async function ensureSharedWorkspaceDir(): Promise<string> {
  return ensureDir(getSharedWorkspaceDir());
}

function toDisplayPath(workspaceRoot: string, absolutePath: string): string {
  if (!isPathInside(workspaceRoot, absolutePath)) {
    return absolutePath;
  }

  const relativePath = path.relative(workspaceRoot, absolutePath);
  return relativePath || ".";
}

async function resolveWorkspacePathForRoot(args: {
  workspaceRoot: string;
  inputPath?: string;
  allowWorkspaceRoot?: boolean;
}): Promise<ResolvedWorkspacePath> {
  const workspaceRoot = args.workspaceRoot;
  const rawPath = (args.inputPath || "").trim();
  if (!rawPath) {
    if (args.allowWorkspaceRoot) {
      return {
        workspaceRoot,
        resolvedPath: workspaceRoot,
        displayPath: ".",
      };
    }

    throw new Error("A workspace path is required.");
  }

  const allowOutsideWorkspace = isAgentWorkspaceOutsideAccessEnabled();
  const resolvedPath = allowOutsideWorkspace && path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(workspaceRoot, rawPath);

  if (!allowOutsideWorkspace && !isPathInside(workspaceRoot, resolvedPath)) {
    throw new Error("Workspace access is limited to the agent workspace root.");
  }

  return {
    workspaceRoot,
    resolvedPath,
    displayPath: toDisplayPath(workspaceRoot, resolvedPath),
  };
}

async function resolveWorkspacePath(args: {
  agentId: RoomAgentId;
  inputPath?: string;
  allowWorkspaceRoot?: boolean;
}): Promise<ResolvedWorkspacePath> {
  return resolveWorkspacePathForRoot({
    workspaceRoot: await ensureWorkspaceDir(args.agentId),
    inputPath: args.inputPath,
    allowWorkspaceRoot: args.allowWorkspaceRoot,
  });
}

async function resolveSharedWorkspacePath(args: {
  inputPath?: string;
  allowWorkspaceRoot?: boolean;
}): Promise<ResolvedWorkspacePath> {
  return resolveWorkspacePathForRoot({
    workspaceRoot: await ensureSharedWorkspaceDir(),
    inputPath: args.inputPath,
    allowWorkspaceRoot: args.allowWorkspaceRoot,
  });
}

function createUpdatedAt(value: { mtime: Date }): string {
  return value.mtime.toISOString();
}

function clampLineWindow(lineCount: number, fromLine?: number, lineCountLimit?: number): { start: number; end: number } {
  if (lineCount === 0) {
    return { start: 0, end: 0 };
  }

  const safeStart = typeof fromLine === "number" && Number.isFinite(fromLine) ? Math.max(1, Math.round(fromLine)) : 1;
  const requestedCount = typeof lineCountLimit === "number" && Number.isFinite(lineCountLimit)
    ? Math.max(1, Math.min(MAX_READ_LINE_COUNT, Math.round(lineCountLimit)))
    : DEFAULT_READ_LINE_COUNT;
  const start = Math.min(lineCount, safeStart) - 1;
  const end = Math.min(lineCount, start + requestedCount);
  return { start, end };
}

async function listWorkspace(target: ResolvedWorkspacePath, recursive = false, requestedLimit?: number): Promise<AgentWorkspaceListResult> {
  const targetStats = await stat(target.resolvedPath).catch(() => null);
  if (!targetStats?.isDirectory()) {
    throw new Error(`Workspace directory not found: ${target.displayPath}`);
  }

  const safeRecursive = Boolean(recursive);
  const limit = typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_LIST_LIMIT, Math.round(requestedLimit)))
    : DEFAULT_LIST_LIMIT;
  const entries: AgentWorkspaceEntry[] = [];
  let truncated = false;

  async function walkDirectory(dirPath: string): Promise<void> {
    const dirEntries = await readdir(dirPath, { withFileTypes: true });
    dirEntries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of dirEntries) {
      if (entries.length >= limit) {
        truncated = true;
        return;
      }

      const absoluteEntryPath = path.join(dirPath, entry.name);
      const entryStats = await stat(absoluteEntryPath);
      entries.push({
        path: toDisplayPath(target.workspaceRoot, absoluteEntryPath),
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
        size: entry.isDirectory() ? 0 : entryStats.size,
        updatedAt: createUpdatedAt(entryStats),
      });

      if (safeRecursive && entry.isDirectory()) {
        await walkDirectory(absoluteEntryPath);
        if (truncated) {
          return;
        }
      }
    }
  }

  await walkDirectory(target.resolvedPath);

  return {
    workspaceRoot: target.workspaceRoot,
    targetPath: target.displayPath,
    recursive: safeRecursive,
    truncated,
    entries,
  };
}

export async function listAgentWorkspace(args: {
  agentId: RoomAgentId;
  path?: string;
  recursive?: boolean;
  limit?: number;
}): Promise<AgentWorkspaceListResult> {
  return listWorkspace(
    await resolveWorkspacePath({
      agentId: args.agentId,
      inputPath: args.path,
      allowWorkspaceRoot: true,
    }),
    args.recursive,
    args.limit,
  );
}

export async function listSharedWorkspace(args: {
  path?: string;
  recursive?: boolean;
  limit?: number;
}): Promise<AgentWorkspaceListResult> {
  return listWorkspace(
    await resolveSharedWorkspacePath({
      inputPath: args.path,
      allowWorkspaceRoot: true,
    }),
    args.recursive,
    args.limit,
  );
}

async function readWorkspaceFile(target: ResolvedWorkspacePath, fromLine?: number, lineCount?: number): Promise<AgentWorkspaceReadResult> {
  const targetStats = await stat(target.resolvedPath).catch(() => null);
  if (!targetStats?.isFile()) {
    throw new Error(`Workspace file not found: ${target.displayPath}`);
  }

  const text = await readFile(target.resolvedPath, "utf8");
  const allLines = text.split(/\r?\n/g);
  const { start, end } = clampLineWindow(allLines.length, fromLine, lineCount);

  return {
    workspaceRoot: target.workspaceRoot,
    path: target.displayPath,
    fromLine: start + 1,
    lineCount: Math.max(0, end - start),
    updatedAt: createUpdatedAt(targetStats),
    text: allLines.slice(start, end).join("\n"),
  };
}

export async function readAgentWorkspaceFile(args: {
  agentId: RoomAgentId;
  path: string;
  fromLine?: number;
  lineCount?: number;
}): Promise<AgentWorkspaceReadResult> {
  return readWorkspaceFile(
    await resolveWorkspacePath({
      agentId: args.agentId,
      inputPath: args.path,
    }),
    args.fromLine,
    args.lineCount,
  );
}

export async function readSharedWorkspaceFile(args: {
  path: string;
  fromLine?: number;
  lineCount?: number;
}): Promise<AgentWorkspaceReadResult> {
  return readWorkspaceFile(
    await resolveSharedWorkspacePath({
      inputPath: args.path,
    }),
    args.fromLine,
    args.lineCount,
  );
}

async function writeWorkspaceFile(target: ResolvedWorkspacePath, content: string): Promise<AgentWorkspaceWriteResult> {
  await mkdir(path.dirname(target.resolvedPath), { recursive: true });
  await writeFile(target.resolvedPath, content, "utf8");
  const targetStats = await stat(target.resolvedPath);

  return {
    workspaceRoot: target.workspaceRoot,
    path: target.displayPath,
    bytesWritten: Buffer.byteLength(content, "utf8"),
    updatedAt: createUpdatedAt(targetStats),
  };
}

export async function writeAgentWorkspaceFile(args: {
  agentId: RoomAgentId;
  path: string;
  content: string;
}): Promise<AgentWorkspaceWriteResult> {
  return writeWorkspaceFile(
    await resolveWorkspacePath({
      agentId: args.agentId,
      inputPath: args.path,
    }),
    args.content,
  );
}

export async function writeSharedWorkspaceFile(args: {
  path: string;
  content: string;
}): Promise<AgentWorkspaceWriteResult> {
  return writeWorkspaceFile(
    await resolveSharedWorkspacePath({
      inputPath: args.path,
    }),
    args.content,
  );
}

async function appendWorkspaceFile(target: ResolvedWorkspacePath, content: string): Promise<AgentWorkspaceAppendResult> {
  const existingStats = await stat(target.resolvedPath).catch(() => null);
  if (existingStats && !existingStats.isFile()) {
    throw new Error(`Workspace path is not a file: ${target.displayPath}`);
  }

  await mkdir(path.dirname(target.resolvedPath), { recursive: true });
  await appendFile(target.resolvedPath, content, "utf8");
  const targetStats = await stat(target.resolvedPath);

  return {
    workspaceRoot: target.workspaceRoot,
    path: target.displayPath,
    bytesAppended: Buffer.byteLength(content, "utf8"),
    updatedAt: createUpdatedAt(targetStats),
  };
}

export async function appendAgentWorkspaceFile(args: {
  agentId: RoomAgentId;
  path: string;
  content: string;
}): Promise<AgentWorkspaceAppendResult> {
  return appendWorkspaceFile(
    await resolveWorkspacePath({
      agentId: args.agentId,
      inputPath: args.path,
    }),
    args.content,
  );
}

export async function appendSharedWorkspaceFile(args: {
  path: string;
  content: string;
}): Promise<AgentWorkspaceAppendResult> {
  return appendWorkspaceFile(
    await resolveSharedWorkspacePath({
      inputPath: args.path,
    }),
    args.content,
  );
}

async function moveWorkspaceEntry(source: ResolvedWorkspacePath, destination: ResolvedWorkspacePath): Promise<AgentWorkspaceMoveResult> {
  if (normalizeForComparison(source.resolvedPath) === normalizeForComparison(source.workspaceRoot)) {
    throw new Error("Moving the workspace root directly is not allowed.");
  }

  const sourceStats = await stat(source.resolvedPath).catch(() => null);
  if (!sourceStats) {
    throw new Error(`Workspace entry not found: ${source.displayPath}`);
  }

  const destinationStats = await stat(destination.resolvedPath).catch(() => null);
  if (destinationStats) {
    throw new Error(`Workspace destination already exists: ${destination.displayPath}`);
  }

  if (sourceStats.isDirectory() && isPathInside(source.resolvedPath, destination.resolvedPath)) {
    throw new Error("Cannot move a workspace directory into itself.");
  }

  await mkdir(path.dirname(destination.resolvedPath), { recursive: true });
  await rename(source.resolvedPath, destination.resolvedPath);
  const updatedStats = await stat(destination.resolvedPath);

  return {
    workspaceRoot: source.workspaceRoot,
    fromPath: source.displayPath,
    toPath: destination.displayPath,
    movedType: sourceStats.isDirectory() ? "directory" : "file",
    updatedAt: createUpdatedAt(updatedStats),
  };
}

export async function moveAgentWorkspaceEntry(args: {
  agentId: RoomAgentId;
  fromPath: string;
  toPath: string;
}): Promise<AgentWorkspaceMoveResult> {
  return moveWorkspaceEntry(
    await resolveWorkspacePath({
      agentId: args.agentId,
      inputPath: args.fromPath,
    }),
    await resolveWorkspacePath({
      agentId: args.agentId,
      inputPath: args.toPath,
    }),
  );
}

export async function moveSharedWorkspaceEntry(args: {
  fromPath: string;
  toPath: string;
}): Promise<AgentWorkspaceMoveResult> {
  return moveWorkspaceEntry(
    await resolveSharedWorkspacePath({
      inputPath: args.fromPath,
    }),
    await resolveSharedWorkspacePath({
      inputPath: args.toPath,
    }),
  );
}

async function mkdirWorkspace(target: ResolvedWorkspacePath, recursive?: boolean): Promise<AgentWorkspaceMkdirResult> {
  const existingStats = await stat(target.resolvedPath).catch(() => null);
  if (existingStats) {
    if (!existingStats.isDirectory()) {
      throw new Error(`Workspace path already exists as a file: ${target.displayPath}`);
    }

    return {
      workspaceRoot: target.workspaceRoot,
      path: target.displayPath,
      created: false,
      updatedAt: createUpdatedAt(existingStats),
    };
  }

  await mkdir(target.resolvedPath, { recursive: recursive ?? true });
  const targetStats = await stat(target.resolvedPath);

  return {
    workspaceRoot: target.workspaceRoot,
    path: target.displayPath,
    created: true,
    updatedAt: createUpdatedAt(targetStats),
  };
}

export async function mkdirAgentWorkspace(args: {
  agentId: RoomAgentId;
  path: string;
  recursive?: boolean;
}): Promise<AgentWorkspaceMkdirResult> {
  return mkdirWorkspace(
    await resolveWorkspacePath({
      agentId: args.agentId,
      inputPath: args.path,
    }),
    args.recursive,
  );
}

export async function mkdirSharedWorkspace(args: {
  path: string;
  recursive?: boolean;
}): Promise<AgentWorkspaceMkdirResult> {
  return mkdirWorkspace(
    await resolveSharedWorkspacePath({
      inputPath: args.path,
    }),
    args.recursive,
  );
}

async function deleteWorkspaceEntry(target: ResolvedWorkspacePath, recursive = false): Promise<AgentWorkspaceDeleteResult> {
  if (normalizeForComparison(target.resolvedPath) === normalizeForComparison(target.workspaceRoot)) {
    throw new Error("Deleting the workspace root directly is not allowed.");
  }

  const targetStats = await stat(target.resolvedPath).catch(() => null);
  if (!targetStats) {
    throw new Error(`Workspace entry not found: ${target.displayPath}`);
  }

  const safeRecursive = Boolean(recursive);
  await rm(target.resolvedPath, {
    recursive: safeRecursive,
    force: false,
  });

  return {
    workspaceRoot: target.workspaceRoot,
    path: target.displayPath,
    deletedType: targetStats.isDirectory() ? "directory" : "file",
    recursive: safeRecursive,
  };
}

export async function deleteAgentWorkspaceEntry(args: {
  agentId: RoomAgentId;
  path: string;
  recursive?: boolean;
}): Promise<AgentWorkspaceDeleteResult> {
  return deleteWorkspaceEntry(
    await resolveWorkspacePath({
      agentId: args.agentId,
      inputPath: args.path,
    }),
    args.recursive,
  );
}

export async function deleteSharedWorkspaceEntry(args: {
  path: string;
  recursive?: boolean;
}): Promise<AgentWorkspaceDeleteResult> {
  return deleteWorkspaceEntry(
    await resolveSharedWorkspacePath({
      inputPath: args.path,
    }),
    args.recursive,
  );
}
