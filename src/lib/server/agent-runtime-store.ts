import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendAgentCompactionMemory, clearAgentMemory } from "./agent-memory-store";
import { runAfterCompactionHooks, runBeforeCompactionHooks } from "@/lib/ai/runtime-hooks";
import type { ProviderCompatibility, RoomAgentId } from "@/lib/chat/types";

export interface PersistedVisibleMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface CompactionRecord {
  id: string;
  createdAt: string;
  reason: "automatic" | "manual";
  summary: string;
  prunedMessages: number;
  keptMessages: number;
  charsBefore: number;
  charsAfter: number;
}

export interface PersistedAgentRuntime {
  version: 1;
  agentId: RoomAgentId;
  history: PersistedVisibleMessage[];
  compactions: CompactionRecord[];
  resolvedModel: string;
  compatibility: ProviderCompatibility | null;
  updatedAt: string;
}

export interface CompactRuntimeResult {
  compacted: boolean;
  record?: CompactionRecord;
  history: PersistedVisibleMessage[];
}

const RUNTIME_ROOT = path.join(process.cwd(), ".oceanking", "agent-runtime");
const AUTO_COMPACT_CHAR_THRESHOLD = 26_000;
const KEEP_RECENT_MESSAGE_COUNT = 8;
const MAX_COMPACTION_RECORDS = 24;

function createTimestamp(): string {
  return new Date().toISOString();
}

function createEmptyRuntime(agentId: RoomAgentId): PersistedAgentRuntime {
  return {
    version: 1,
    agentId,
    history: [],
    compactions: [],
    resolvedModel: "",
    compatibility: null,
    updatedAt: createTimestamp(),
  };
}

function getRuntimeFilePath(agentId: RoomAgentId): string {
  return path.join(RUNTIME_ROOT, `${agentId}.json`);
}

async function ensureRuntimeDir(): Promise<void> {
  await mkdir(RUNTIME_ROOT, { recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeMessage(value: unknown): PersistedVisibleMessage | null {
  if (!isRecord(value)) {
    return null;
  }

  if ((value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") {
    return null;
  }

  return {
    id: typeof value.id === "string" && value.id ? value.id : crypto.randomUUID(),
    role: value.role,
    content: value.content,
    createdAt: typeof value.createdAt === "string" && value.createdAt ? value.createdAt : createTimestamp(),
  };
}

function normalizeCompactionRecord(value: unknown): CompactionRecord | null {
  if (!isRecord(value) || (value.reason !== "automatic" && value.reason !== "manual")) {
    return null;
  }

  return {
    id: typeof value.id === "string" && value.id ? value.id : crypto.randomUUID(),
    createdAt: typeof value.createdAt === "string" && value.createdAt ? value.createdAt : createTimestamp(),
    reason: value.reason,
    summary: typeof value.summary === "string" ? value.summary : "",
    prunedMessages:
      typeof value.prunedMessages === "number" && Number.isFinite(value.prunedMessages)
        ? Math.max(0, Math.round(value.prunedMessages))
        : 0,
    keptMessages:
      typeof value.keptMessages === "number" && Number.isFinite(value.keptMessages)
        ? Math.max(0, Math.round(value.keptMessages))
        : 0,
    charsBefore:
      typeof value.charsBefore === "number" && Number.isFinite(value.charsBefore)
        ? Math.max(0, Math.round(value.charsBefore))
        : 0,
    charsAfter:
      typeof value.charsAfter === "number" && Number.isFinite(value.charsAfter)
        ? Math.max(0, Math.round(value.charsAfter))
        : 0,
  };
}

function normalizeRuntime(agentId: RoomAgentId, value: unknown): PersistedAgentRuntime {
  if (!isRecord(value)) {
    return createEmptyRuntime(agentId);
  }

  return {
    version: 1,
    agentId,
    history: Array.isArray(value.history)
      ? value.history.map((item) => normalizeMessage(item)).filter((item): item is PersistedVisibleMessage => Boolean(item))
      : [],
    compactions: Array.isArray(value.compactions)
      ? value.compactions
          .map((item) => normalizeCompactionRecord(item))
          .filter((item): item is CompactionRecord => Boolean(item))
          .slice(-MAX_COMPACTION_RECORDS)
      : [],
    resolvedModel: typeof value.resolvedModel === "string" ? value.resolvedModel : "",
    compatibility: isRecord(value.compatibility) ? (value.compatibility as unknown as ProviderCompatibility) : null,
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt ? value.updatedAt : createTimestamp(),
  };
}

function estimateHistoryChars(messages: PersistedVisibleMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function truncateLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trim()}...`;
}

function extractRoomEnvelopeDetail(message: PersistedVisibleMessage): { roomLabel?: string; visibleMessage?: string } {
  const roomIdMatch = message.content.match(/Room ID:\s*(.+)/);
  const roomTitleMatch = message.content.match(/Room Title:\s*(.+)/);
  const visibleMessageMatch = message.content.match(/Visible room message:\n([\s\S]+)$/);
  return {
    roomLabel:
      roomTitleMatch?.[1]?.trim() && roomIdMatch?.[1]?.trim()
        ? `${roomTitleMatch[1].trim()} (${roomIdMatch[1].trim()})`
        : roomIdMatch?.[1]?.trim(),
    visibleMessage: visibleMessageMatch?.[1]?.trim(),
  };
}

function collectSectionLines(content: string, heading: string): string[] {
  const blockMatch = content.match(new RegExp(`${heading}:\\n([\\s\\S]+?)(?:\\n\\n[A-Z][^\\n]+:|$)`));
  if (!blockMatch?.[1]) {
    return [];
  }

  return blockMatch[1]
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
}

function buildCompactionSummary(messages: PersistedVisibleMessage[]): string {
  const rooms = new Set<string>();
  const userRequests: string[] = [];
  const deliveries: string[] = [];
  const toolFindings: string[] = [];
  const roomActions: string[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      const detail = extractRoomEnvelopeDetail(message);
      if (detail.roomLabel) {
        rooms.add(detail.roomLabel);
      }
      if (detail.visibleMessage) {
        userRequests.push(`- ${truncateLine(detail.visibleMessage, 220)}`);
      } else {
        userRequests.push(`- ${truncateLine(message.content, 220)}`);
      }
      continue;
    }

    deliveries.push(...collectSectionLines(message.content, "Visible room deliveries").slice(0, 4));
    roomActions.push(...collectSectionLines(message.content, "Room actions").slice(0, 4));
    toolFindings.push(...collectSectionLines(message.content, "Tool results used").slice(0, 4));
  }

  const sections = [
    "[Compacted shared history summary]",
    rooms.size > 0 ? `Rooms involved: ${[...rooms].join(", ")}` : "Rooms involved: unknown",
    "",
    "Important prior requests:",
    ...(userRequests.slice(-6).length > 0 ? userRequests.slice(-6) : ["- none recorded"]),
    "",
    "Visible deliveries already made:",
    ...(deliveries.slice(-6).length > 0 ? deliveries.slice(-6) : ["- none recorded"]),
    "",
    "Room actions already taken:",
    ...(roomActions.slice(-6).length > 0 ? roomActions.slice(-6) : ["- none recorded"]),
    "",
    "Tool findings worth keeping:",
    ...(toolFindings.slice(-6).length > 0 ? toolFindings.slice(-6) : ["- none recorded"]),
    "",
    "Treat this summary as compressed shared memory. Prefer newer tool results over older assumptions.",
  ];

  return sections.join("\n").trim();
}

export async function loadPersistedAgentRuntime(agentId: RoomAgentId): Promise<PersistedAgentRuntime> {
  await ensureRuntimeDir();
  const filePath = getRuntimeFilePath(agentId);
  const raw = await readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return createEmptyRuntime(agentId);
  }

  try {
    return normalizeRuntime(agentId, JSON.parse(raw) as unknown);
  } catch {
    return createEmptyRuntime(agentId);
  }
}

export async function savePersistedAgentRuntime(runtime: PersistedAgentRuntime): Promise<void> {
  await ensureRuntimeDir();
  await writeFile(getRuntimeFilePath(runtime.agentId), JSON.stringify(runtime, null, 2), "utf8");
}

export async function appendPersistedHistoryMessage(args: {
  agentId: RoomAgentId;
  message: Omit<PersistedVisibleMessage, "id" | "createdAt"> & Partial<Pick<PersistedVisibleMessage, "id" | "createdAt">>;
}): Promise<PersistedAgentRuntime> {
  const runtime = await loadPersistedAgentRuntime(args.agentId);
  runtime.history.push({
    id: args.message.id || crypto.randomUUID(),
    role: args.message.role,
    content: args.message.content,
    createdAt: args.message.createdAt || createTimestamp(),
  });
  runtime.updatedAt = createTimestamp();
  await savePersistedAgentRuntime(runtime);
  return runtime;
}

export async function finalizePersistedAgentRuntime(args: {
  agentId: RoomAgentId;
  assistantMessage: PersistedVisibleMessage;
  resolvedModel: string;
  compatibility: ProviderCompatibility;
}): Promise<void> {
  const runtime = await loadPersistedAgentRuntime(args.agentId);
  runtime.history.push(args.assistantMessage);
  runtime.resolvedModel = args.resolvedModel;
  runtime.compatibility = args.compatibility;
  runtime.updatedAt = createTimestamp();
  await savePersistedAgentRuntime(runtime);
}

export async function compactPersistedAgentRuntime(args: {
  agentId: RoomAgentId;
  reason: "automatic" | "manual";
  force?: boolean;
}): Promise<CompactRuntimeResult> {
  const runtime = await loadPersistedAgentRuntime(args.agentId);
  const charsBefore = estimateHistoryChars(runtime.history);
  const shouldCompact =
    runtime.history.length >= 4
    && (args.force || (runtime.history.length > KEEP_RECENT_MESSAGE_COUNT + 2 && charsBefore >= AUTO_COMPACT_CHAR_THRESHOLD));
  if (!shouldCompact) {
    return {
      compacted: false,
      history: runtime.history,
    };
  }

  let splitIndex = args.force
    ? Math.max(2, Math.floor(runtime.history.length / 2))
    : Math.max(1, runtime.history.length - KEEP_RECENT_MESSAGE_COUNT);
  if (splitIndex % 2 !== 0 && splitIndex < runtime.history.length - 1) {
    splitIndex += 1;
  }
  const prunedMessages = runtime.history.slice(0, splitIndex);
  const keptMessages = runtime.history.slice(splitIndex);
  if (prunedMessages.length === 0) {
    return {
      compacted: false,
      history: runtime.history,
    };
  }

  await runBeforeCompactionHooks({
    agentId: args.agentId,
    reason: args.reason,
    historyCount: runtime.history.length,
    charsBefore,
  });

  const summary = buildCompactionSummary(prunedMessages);
  const summaryMessage: PersistedVisibleMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: summary,
    createdAt: createTimestamp(),
  };

  runtime.history = [summaryMessage, ...keptMessages];
  const charsAfter = estimateHistoryChars(runtime.history);
  const record: CompactionRecord = {
    id: crypto.randomUUID(),
    createdAt: summaryMessage.createdAt,
    reason: args.reason,
    summary,
    prunedMessages: prunedMessages.length,
    keptMessages: keptMessages.length,
    charsBefore,
    charsAfter,
  };
  runtime.compactions = [...runtime.compactions, record].slice(-MAX_COMPACTION_RECORDS);
  runtime.updatedAt = createTimestamp();
  await savePersistedAgentRuntime(runtime);
  await appendAgentCompactionMemory({
    agentId: args.agentId,
    summary,
    reason: args.reason,
    prunedMessages: prunedMessages.length,
    charsBefore,
    charsAfter,
  });
  await runAfterCompactionHooks({
    agentId: args.agentId,
    reason: args.reason,
    historyCount: runtime.history.length,
    charsBefore,
    charsAfter,
    summary,
    prunedMessages: prunedMessages.length,
  });

  return {
    compacted: true,
    record,
    history: runtime.history,
  };
}

export async function resetPersistedAgentRuntime(agentId: RoomAgentId): Promise<void> {
  await rm(getRuntimeFilePath(agentId), { force: true });
  await clearAgentMemory(agentId);
}
