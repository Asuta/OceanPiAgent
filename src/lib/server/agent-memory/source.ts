import crypto from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RoomAgentId, ToolExecution } from "@/lib/chat/types";
import type { AgentMemorySummary, MemoryFileSlice, ReadAgentMemoryFileArgs } from "./types";

export const TIMELINE_FILE_NAME = "timeline.md";
export const TIMELINE_DIR_NAME = "timeline";
export const COMPACTIONS_FILE_NAME = "compactions.md";
export const RECENT_TIMELINE_FILE_SCAN_LIMIT = 3;
export const MEMORY_SEARCH_BLOCK_SIZE = 6;

export interface MemoryMarkdownFile {
  path: string;
  absolutePath: string;
  kind: "timeline" | "compactions" | "other";
  shardKey: string;
}

export interface MemorySourceDocument extends MemoryMarkdownFile {
  text: string;
  checksum: string;
}

export interface MemorySearchChunk {
  startLine: number;
  endLine: number;
  text: string;
}

export function getMemoryRootPath(): string {
  return path.join(process.cwd(), ".oceanking", "memory");
}

export function getMemoryIndexRootPath(): string {
  return path.join(process.cwd(), ".oceanking", "memory-index");
}

export function createTimestamp(): string {
  return new Date().toISOString();
}

export function createTimelineShardName(timestamp = createTimestamp()): string {
  return `${timestamp.slice(0, 7)}.md`;
}

export function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

export function tokenize(value: string): string[] {
  return value
    .split(/\s+/g)
    .map(normalizeToken)
    .filter((token) => token.length >= 2);
}

export function toLinePreview(lines: string[], start: number, end: number): string {
  return lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n")
    .trim();
}

export function clampLineWindow(lineCount: number, from?: number, lines?: number): { start: number; end: number } {
  const safeStart = typeof from === "number" && Number.isFinite(from) ? Math.max(1, Math.round(from)) : 1;
  const safeLines = typeof lines === "number" && Number.isFinite(lines) ? Math.max(1, Math.round(lines)) : lineCount;
  const start = Math.min(lineCount, safeStart) - 1;
  const end = Math.min(lineCount, start + safeLines);
  return { start, end };
}

export async function ensureMemoryDir(agentId: RoomAgentId): Promise<string> {
  const dirPath = path.join(getMemoryRootPath(), agentId);
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

export async function ensureMemoryIndexDir(): Promise<string> {
  const rootPath = getMemoryIndexRootPath();
  await mkdir(rootPath, { recursive: true });
  return rootPath;
}

export function getMemoryDir(agentId: RoomAgentId): string {
  return path.join(getMemoryRootPath(), agentId);
}

export function getTimelineDir(agentId: RoomAgentId): string {
  return path.join(getMemoryDir(agentId), TIMELINE_DIR_NAME);
}

export function getMemoryIndexPath(agentId: RoomAgentId): string {
  return path.join(getMemoryIndexRootPath(), `${agentId}.sqlite`);
}

export function getTimelineShardKey(relPath: string): string {
  if (relPath === TIMELINE_FILE_NAME) {
    return "0000-00";
  }

  const match = /^timeline\/(\d{4}-\d{2})\.md$/u.exec(relPath);
  return match?.[1] ?? "";
}

export function toMemoryFileKind(relPath: string): MemoryMarkdownFile["kind"] {
  if (relPath === COMPACTIONS_FILE_NAME) {
    return "compactions";
  }

  if (relPath === TIMELINE_FILE_NAME || relPath.startsWith(`${TIMELINE_DIR_NAME}/`)) {
    return "timeline";
  }

  return "other";
}

export function orderFilesForSearch<T extends MemoryMarkdownFile>(files: T[]): Array<T & { searchOrder: number }> {
  const timelineFiles = files
    .filter((file) => file.kind === "timeline")
    .sort((left, right) => right.shardKey.localeCompare(left.shardKey) || left.path.localeCompare(right.path));
  const recentTimelineFiles = timelineFiles.slice(0, RECENT_TIMELINE_FILE_SCAN_LIMIT);
  const olderTimelineFiles = timelineFiles.slice(RECENT_TIMELINE_FILE_SCAN_LIMIT);
  const compactionFiles = files
    .filter((file) => file.kind === "compactions")
    .sort((left, right) => left.path.localeCompare(right.path));
  const otherFiles = files
    .filter((file) => file.kind === "other")
    .sort((left, right) => left.path.localeCompare(right.path));

  return [...recentTimelineFiles, ...compactionFiles, ...otherFiles, ...olderTimelineFiles].map((file, index) => ({
    ...file,
    searchOrder: index,
  }));
}

async function appendMarkdownSection(filePath: string, heading: string, bodyLines: string[]): Promise<void> {
  const existing = await readFile(filePath, "utf8").catch(() => "");
  const body = bodyLines.filter(Boolean).join("\n").trim();
  const next = `${existing.trimEnd()}${existing ? "\n\n" : ""}## ${heading}\n\n${body}\n`;
  await writeFile(filePath, next, "utf8");
}

function formatToolSummary(tools: ToolExecution[]): string[] {
  if (tools.length === 0) {
    return ["- none"];
  }

  return tools.slice(-8).map((tool) => {
    const preview = tool.resultPreview.trim() || tool.outputText.trim() || "no result";
    return `- ${tool.displayName}: ${preview}`;
  });
}

function formatEmittedMessages(emittedMessages: Array<{ roomId: string; content: string; kind: string; status: string; final: boolean }>): string[] {
  if (emittedMessages.length === 0) {
    return ["- none"];
  }

  return emittedMessages.map((message) => `- room ${message.roomId} [${message.kind}/${message.status}${message.final ? "/final" : ""}]: ${message.content}`);
}

export async function appendAgentTurnMemoryFile(args: {
  agentId: RoomAgentId;
  roomId: string;
  roomTitle: string;
  userMessageId: string;
  senderName: string;
  userContent: string;
  assistantContent: string;
  tools: ToolExecution[];
  emittedMessages: Array<{ roomId: string; content: string; kind: string; status: string; final: boolean }>;
  resolvedModel: string;
}): Promise<{ relPath: string; absolutePath: string }> {
  await ensureMemoryDir(args.agentId);
  const timelineDirPath = getTimelineDir(args.agentId);
  await mkdir(timelineDirPath, { recursive: true });
  const relPath = `${TIMELINE_DIR_NAME}/${createTimelineShardName()}`;
  const filePath = path.join(getMemoryDir(args.agentId), relPath);
  const heading = `${createTimestamp()} · ${args.roomTitle} (${args.roomId})`;
  await appendMarkdownSection(filePath, heading, [
    `- roomId: ${args.roomId}`,
    `- roomTitle: ${args.roomTitle}`,
    `- userMessageId: ${args.userMessageId}`,
    `- sender: ${args.senderName}`,
    `- resolvedModel: ${args.resolvedModel || "unknown"}`,
    "",
    "### User message",
    args.userContent.trim() || "(empty)",
    "",
    "### Assistant draft",
    args.assistantContent.trim() || "(no internal text)",
    "",
    "### Visible room deliveries",
    ...formatEmittedMessages(args.emittedMessages),
    "",
    "### Tool results",
    ...formatToolSummary(args.tools),
  ]);
  return { relPath, absolutePath: filePath };
}

export async function appendAgentCompactionMemoryFile(args: {
  agentId: RoomAgentId;
  summary: string;
  reason: string;
  prunedMessages: number;
  charsBefore: number;
  charsAfter: number;
}): Promise<{ relPath: string; absolutePath: string }> {
  const dirPath = await ensureMemoryDir(args.agentId);
  const relPath = COMPACTIONS_FILE_NAME;
  const filePath = path.join(dirPath, relPath);
  const heading = `${createTimestamp()} · ${args.reason}`;
  await appendMarkdownSection(filePath, heading, [
    `- reason: ${args.reason}`,
    `- prunedMessages: ${args.prunedMessages}`,
    `- charsBefore: ${args.charsBefore}`,
    `- charsAfter: ${args.charsAfter}`,
    "",
    "### Summary",
    args.summary.trim() || "(empty)",
  ]);
  return { relPath, absolutePath: filePath };
}

export async function listMarkdownFiles(agentId: RoomAgentId): Promise<MemoryMarkdownFile[]> {
  const dirPath = getMemoryDir(agentId);
  const timelineDirPath = getTimelineDir(agentId);
  const [rootEntries, timelineEntries] = await Promise.all([
    readdir(dirPath, { withFileTypes: true }).catch(() => []),
    readdir(timelineDirPath, { withFileTypes: true }).catch(() => []),
  ]);

  const files: MemoryMarkdownFile[] = rootEntries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => ({
      path: entry.name,
      absolutePath: path.join(dirPath, entry.name),
      kind: toMemoryFileKind(entry.name),
      shardKey: getTimelineShardKey(entry.name),
    }));

  files.push(
    ...timelineEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => {
        const relPath = `${TIMELINE_DIR_NAME}/${entry.name}`;
        return {
          path: relPath,
          absolutePath: path.join(timelineDirPath, entry.name),
          kind: toMemoryFileKind(relPath),
          shardKey: getTimelineShardKey(relPath),
        };
      }),
  );

  return files;
}

export async function collectMemorySourceDocuments(agentId: RoomAgentId): Promise<MemorySourceDocument[]> {
  const files = await listMarkdownFiles(agentId);
  return Promise.all(
    files.map(async (file) => {
      const text = await readFile(file.absolutePath, "utf8").catch(() => "");
      return {
        ...file,
        text,
        checksum: crypto.createHash("sha1").update(text).digest("hex"),
      };
    }),
  );
}

export function buildSearchChunks(text: string): MemorySearchChunk[] {
  if (!text.trim()) {
    return [];
  }

  const lines = text.split(/\r?\n/g);
  const chunks: MemorySearchChunk[] = [];

  for (let index = 0; index < lines.length; index += MEMORY_SEARCH_BLOCK_SIZE) {
    const end = Math.min(lines.length, index + MEMORY_SEARCH_BLOCK_SIZE);
    const snippet = lines.slice(index, end).join("\n").trim();
    if (!snippet) {
      continue;
    }
    chunks.push({
      startLine: index + 1,
      endLine: end,
      text: snippet,
    });
  }

  return chunks;
}

export async function readAgentMemoryFileSource(args: ReadAgentMemoryFileArgs): Promise<MemoryFileSlice> {
  const trimmedPath = args.relPath.trim();
  if (!trimmedPath || trimmedPath.includes("..") || path.isAbsolute(trimmedPath)) {
    throw new Error("Invalid memory path.");
  }

  const dirPath = getMemoryDir(args.agentId);
  const filePath = path.join(dirPath, trimmedPath);
  const fileStats = await stat(filePath).catch(() => null);
  if (!fileStats?.isFile()) {
    throw new Error(`Memory file not found: ${trimmedPath}`);
  }

  const text = await readFile(filePath, "utf8");
  const allLines = text.split(/\r?\n/g);
  const { start, end } = clampLineWindow(allLines.length, args.from, args.lines);

  return {
    path: trimmedPath,
    from: start + 1,
    lines: Math.max(0, end - start),
    text: toLinePreview(allLines, start, end),
  };
}

export async function clearAgentMemorySource(agentId: RoomAgentId): Promise<void> {
  await rm(getMemoryDir(agentId), { recursive: true, force: true });
  await rm(getMemoryIndexPath(agentId), { force: true }).catch(() => undefined);
}

export async function getAgentMemorySummarySource(agentId: RoomAgentId): Promise<AgentMemorySummary> {
  const files = await listMarkdownFiles(agentId);
  return {
    fileCount: files.length,
    hasTimeline: files.some((file) => file.kind === "timeline"),
    hasCompactions: files.some((file) => file.kind === "compactions"),
  };
}
