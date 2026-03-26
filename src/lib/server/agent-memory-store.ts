import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RoomAgentId, ToolExecution } from "@/lib/chat/types";

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
}

export interface MemoryFileSlice {
  path: string;
  from: number;
  lines: number;
  text: string;
}

const MEMORY_ROOT = path.join(process.cwd(), ".oceanking", "memory");
const TIMELINE_FILE_NAME = "timeline.md";
const TIMELINE_DIR_NAME = "timeline";
const COMPACTIONS_FILE_NAME = "compactions.md";
const RECENT_TIMELINE_FILE_SCAN_LIMIT = 3;

interface MemoryMarkdownFile {
  path: string;
  absolutePath: string;
  kind: "timeline" | "compactions" | "other";
  shardKey: string;
}

function createTimestamp(): string {
  return new Date().toISOString();
}

function createTimelineShardName(timestamp = createTimestamp()): string {
  return `${timestamp.slice(0, 7)}.md`;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function tokenize(value: string): string[] {
  return value
    .split(/\s+/g)
    .map(normalizeToken)
    .filter((token) => token.length >= 2);
}

function toLinePreview(lines: string[], start: number, end: number): string {
  return lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n")
    .trim();
}

function clampLineWindow(lineCount: number, from?: number, lines?: number): { start: number; end: number } {
  const safeStart = typeof from === "number" && Number.isFinite(from) ? Math.max(1, Math.round(from)) : 1;
  const safeLines = typeof lines === "number" && Number.isFinite(lines) ? Math.max(1, Math.round(lines)) : lineCount;
  const start = Math.min(lineCount, safeStart) - 1;
  const end = Math.min(lineCount, start + safeLines);
  return { start, end };
}

async function ensureMemoryDir(agentId: RoomAgentId): Promise<string> {
  const dirPath = path.join(MEMORY_ROOT, agentId);
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

function getMemoryDir(agentId: RoomAgentId): string {
  return path.join(MEMORY_ROOT, agentId);
}

function getTimelineDir(agentId: RoomAgentId): string {
  return path.join(getMemoryDir(agentId), TIMELINE_DIR_NAME);
}

function getTimelineShardKey(relPath: string): string {
  if (relPath === TIMELINE_FILE_NAME) {
    return "0000-00";
  }

  const match = /^timeline\/(\d{4}-\d{2})\.md$/u.exec(relPath);
  return match?.[1] ?? "";
}

function toMemoryFileKind(relPath: string): MemoryMarkdownFile["kind"] {
  if (relPath === COMPACTIONS_FILE_NAME) {
    return "compactions";
  }

  if (relPath === TIMELINE_FILE_NAME || relPath.startsWith(`${TIMELINE_DIR_NAME}/`)) {
    return "timeline";
  }

  return "other";
}

function orderFilesForSearch(files: MemoryMarkdownFile[]): Array<MemoryMarkdownFile & { searchOrder: number }> {
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

  return emittedMessages.map((message) => {
    return `- room ${message.roomId} [${message.kind}/${message.status}${message.final ? "/final" : ""}]: ${message.content}`;
  });
}

export async function appendAgentTurnMemory(args: {
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
}): Promise<void> {
  await ensureMemoryDir(args.agentId);
  const timelineDirPath = getTimelineDir(args.agentId);
  await mkdir(timelineDirPath, { recursive: true });
  const filePath = path.join(timelineDirPath, createTimelineShardName());
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
}

export async function appendAgentCompactionMemory(args: {
  agentId: RoomAgentId;
  summary: string;
  reason: string;
  prunedMessages: number;
  charsBefore: number;
  charsAfter: number;
}): Promise<void> {
  const dirPath = await ensureMemoryDir(args.agentId);
  const filePath = path.join(dirPath, COMPACTIONS_FILE_NAME);
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
}

async function listMarkdownFiles(agentId: RoomAgentId): Promise<MemoryMarkdownFile[]> {
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

export async function searchAgentMemory(
  agentId: RoomAgentId,
  query: string,
  options?: { maxResults?: number; minScore?: number },
): Promise<MemorySearchResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const files = await listMarkdownFiles(agentId);
  if (files.length === 0) {
    return [];
  }
  const orderedFiles = orderFilesForSearch(files);
  const timelineFileCount = files.filter((file) => file.kind === "timeline").length;
  const nonTimelineFileCount = orderedFiles.filter((file) => file.kind !== "timeline").length;
  const olderTimelineStartIndex = Math.min(
    orderedFiles.length,
    Math.min(timelineFileCount, RECENT_TIMELINE_FILE_SCAN_LIMIT) + nonTimelineFileCount,
  );

  const queryTokens = new Set(tokenize(normalizedQuery));
  const maxResults = typeof options?.maxResults === "number" && Number.isFinite(options.maxResults)
    ? Math.max(1, Math.min(20, Math.round(options.maxResults)))
    : 8;
  const minScore = typeof options?.minScore === "number" && Number.isFinite(options.minScore)
    ? options.minScore
    : 0;

  const results: MemorySearchResult[] = [];
  const resultOrder = new Map<string, number>();

  for (let index = 0; index < orderedFiles.length; index += 1) {
    if (index >= olderTimelineStartIndex && results.length >= maxResults) {
      break;
    }

    const file = orderedFiles[index];
    const text = await readFile(file.absolutePath, "utf8").catch(() => "");
    if (!text.trim()) {
      continue;
    }

    const lines = text.split(/\r?\n/g);
    const blockSize = 6;
    for (let index = 0; index < lines.length; index += blockSize) {
      const end = Math.min(lines.length, index + blockSize);
      const snippet = lines.slice(index, end).join("\n").trim();
      if (!snippet) {
        continue;
      }

      const lineTokens = tokenize(snippet);
      const overlap = lineTokens.reduce((count, token) => count + (queryTokens.has(token) ? 1 : 0), 0);
      const substringBoost = snippet.toLowerCase().includes(normalizedQuery.toLowerCase()) ? 2 : 0;
      const headingBoost = lines[index]?.startsWith("## ") ? 1 : 0;
      const matchScore = overlap + substringBoost;
      if (matchScore <= 0) {
        continue;
      }

      const score = matchScore + headingBoost;
      if (score < minScore) {
        continue;
      }

      results.push({
        path: file.path,
        startLine: index + 1,
        endLine: end,
        snippet: toLinePreview(lines, index, end),
        score,
      });
      resultOrder.set(`${file.path}:${index + 1}:${end}`, file.searchOrder);
    }
  }

  return results
    .sort(
      (left, right) =>
        right.score - left.score
        || (resultOrder.get(`${left.path}:${left.startLine}:${left.endLine}`) ?? Number.MAX_SAFE_INTEGER)
          - (resultOrder.get(`${right.path}:${right.startLine}:${right.endLine}`) ?? Number.MAX_SAFE_INTEGER)
        || left.path.localeCompare(right.path)
        || left.startLine - right.startLine,
    )
    .slice(0, maxResults);
}

export async function readAgentMemoryFile(args: {
  agentId: RoomAgentId;
  relPath: string;
  from?: number;
  lines?: number;
}): Promise<MemoryFileSlice> {
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

export async function clearAgentMemory(agentId: RoomAgentId): Promise<void> {
  await rm(getMemoryDir(agentId), { recursive: true, force: true });
}

export async function getAgentMemorySummary(agentId: RoomAgentId): Promise<{ fileCount: number; hasTimeline: boolean; hasCompactions: boolean }> {
  const files = await listMarkdownFiles(agentId);
  return {
    fileCount: files.length,
    hasTimeline: files.some((file) => file.kind === "timeline"),
    hasCompactions: files.some((file) => file.kind === "compactions"),
  };
}
