import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateCompactionSummary } from "./agent-compaction";
import { appendAgentCompactionMemory, clearAgentMemory } from "./agent-memory-store";
import { appendAgentLcmMessage, assembleAgentLcmContext, clearAgentLcmConversation, compactAgentLcmContext, getAgentLcmRetrieval, getOrCreateAgentConversation } from "./lcm/facade";
import { runAfterCompactionHooks, runBeforeCompactionHooks } from "@/lib/ai/runtime-hooks";
import type { AssistantMessageMeta, MessageImageAttachment, ProviderCompatibility, RoomAgentId } from "@/lib/chat/types";
import { createUuid } from "@/lib/utils/uuid";

export interface PersistedVisibleMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments: MessageImageAttachment[];
  meta?: AssistantMessageMeta;
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
    id: typeof value.id === "string" && value.id ? value.id : createUuid(),
    role: value.role,
    content: value.content,
    attachments: Array.isArray(value.attachments)
      ? value.attachments.filter(
          (attachment): attachment is MessageImageAttachment =>
            typeof attachment === "object"
            && attachment !== null
            && (attachment as MessageImageAttachment).kind === "image"
            && typeof (attachment as MessageImageAttachment).id === "string"
            && typeof (attachment as MessageImageAttachment).mimeType === "string"
            && typeof (attachment as MessageImageAttachment).filename === "string"
            && typeof (attachment as MessageImageAttachment).sizeBytes === "number"
            && typeof (attachment as MessageImageAttachment).storagePath === "string"
            && typeof (attachment as MessageImageAttachment).url === "string",
        )
      : [],
    ...(isRecord(value.meta)
      ? {
          meta: value.meta as unknown as AssistantMessageMeta,
        }
      : {}),
    createdAt: typeof value.createdAt === "string" && value.createdAt ? value.createdAt : createTimestamp(),
  };
}

function normalizeCompactionRecord(value: unknown): CompactionRecord | null {
  if (!isRecord(value) || (value.reason !== "automatic" && value.reason !== "manual")) {
    return null;
  }

  return {
    id: typeof value.id === "string" && value.id ? value.id : createUuid(),
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
  return messages.reduce((total, message) => total + message.content.length + message.attachments.length * 64, 0);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== "object") {
          return "";
        }
        if (typeof (block as { text?: unknown }).text === "string") {
          return (block as { text: string }).text;
        }
        if (typeof (block as { output?: unknown }).output === "string") {
          return (block as { output: string }).output;
        }
        return JSON.stringify(block);
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

function extractSummaryText(content: string): string {
  const match = /<content>\s*\n?([\s\S]*?)\n?\s*<\/content>/u.exec(content);
  return match?.[1] ?? content;
}

async function assembleLcmPersistedHistory(agentId: RoomAgentId): Promise<PersistedVisibleMessage[] | null> {
  const assembled = await assembleAgentLcmContext(agentId, 20_000);
  if (!assembled) {
    return null;
  }

  return assembled.messages.map((message, index) => ({
    id: `lcm-${index}-${createUuid()}`,
    role: message.role === "user" && typeof message.content === "string" && message.content.includes("<summary ") ? "assistant" : (message.role === "user" ? "user" : "assistant"),
    content: typeof message.content === "string" && message.content.includes("<summary ") ? extractSummaryText(message.content) : contentToText(message.content),
    attachments: [],
    createdAt: createTimestamp(),
  }));
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
  message: Omit<PersistedVisibleMessage, "id" | "createdAt" | "attachments" | "meta"> & Partial<Pick<PersistedVisibleMessage, "id" | "createdAt" | "attachments" | "meta">>;
}): Promise<PersistedAgentRuntime> {
  await getOrCreateAgentConversation(args.agentId);
  const runtime = await loadPersistedAgentRuntime(args.agentId);
  runtime.history.push({
    id: args.message.id || createUuid(),
    role: args.message.role,
    content: args.message.content,
    attachments: args.message.attachments ? [...args.message.attachments] : [],
    ...(args.message.meta ? { meta: args.message.meta } : {}),
    createdAt: args.message.createdAt || createTimestamp(),
  });
  runtime.updatedAt = createTimestamp();
  await savePersistedAgentRuntime(runtime);
  await appendAgentLcmMessage({
    agentId: args.agentId,
    role: args.message.role,
    content: args.message.content,
    createdAt: args.message.createdAt || createTimestamp(),
    parts: [
      {
        sessionId: `agent:${args.agentId}`,
        partType: "text",
        ordinal: 0,
        textContent: args.message.content,
        metadata: JSON.stringify({ originalRole: args.message.role, rawType: "runtime_history_seed", attachments: args.message.attachments ?? [], meta: args.message.meta }),
      },
    ],
  }).catch(() => undefined);
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
  const lcmCompaction = await compactAgentLcmContext(args.agentId, 20_000, args.force).catch(() => null);
  if (lcmCompaction) {
    const runtime = await loadPersistedAgentRuntime(args.agentId);
    const lcmHistory = (await assembleLcmPersistedHistory(args.agentId)) ?? runtime.history;
    const charsBefore = estimateHistoryChars(runtime.history);
    const charsAfter = estimateHistoryChars(lcmHistory);
    if (!lcmCompaction.actionTaken) {
      runtime.history = lcmHistory;
      runtime.updatedAt = createTimestamp();
      await savePersistedAgentRuntime(runtime);
      return { compacted: false, history: lcmHistory };
    }

    await runBeforeCompactionHooks({
      agentId: args.agentId,
      reason: args.reason,
      historyCount: runtime.history.length,
      charsBefore,
    });
    const describedSummary = lcmCompaction.createdSummaryId
      ? await getAgentLcmRetrieval(args.agentId)
          .then(({ retrieval }) => retrieval.describe(lcmCompaction.createdSummaryId!))
          .catch(() => null)
      : null;
    const summary = describedSummary?.summary?.content || (lcmCompaction.createdSummaryId ? `LCM summary ${lcmCompaction.createdSummaryId}` : "LCM compaction");
    const record: CompactionRecord = {
      id: createUuid(),
      createdAt: createTimestamp(),
      reason: args.reason,
      summary,
      prunedMessages: Math.max(0, runtime.history.length - lcmHistory.length),
      keptMessages: lcmHistory.length,
      charsBefore,
      charsAfter,
    };
    runtime.history = lcmHistory;
    runtime.compactions = [...runtime.compactions, record].slice(-MAX_COMPACTION_RECORDS);
    runtime.updatedAt = createTimestamp();
    await savePersistedAgentRuntime(runtime);
    await appendAgentCompactionMemory({
      agentId: args.agentId,
      summary,
      reason: args.reason,
      prunedMessages: record.prunedMessages,
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
      prunedMessages: record.prunedMessages,
    });
    return {
      compacted: true,
      record,
      history: lcmHistory,
    };
  }

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
  const candidatePrunedMessages = runtime.history.slice(0, splitIndex);
  const prunedMessages = candidatePrunedMessages.filter((message) => message.attachments.length === 0);
  const keptMessages = runtime.history.filter((message, index) => index >= splitIndex || message.attachments.length > 0);
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

  const summary = await generateCompactionSummary({
    agentId: args.agentId,
    messages: prunedMessages,
    resolvedModel: runtime.resolvedModel,
  });
  const summaryMessage: PersistedVisibleMessage = {
    id: createUuid(),
    role: "assistant",
    content: summary,
    attachments: [],
    createdAt: createTimestamp(),
  };

  runtime.history = [summaryMessage, ...keptMessages];
  const charsAfter = estimateHistoryChars(runtime.history);
  const record: CompactionRecord = {
    id: createUuid(),
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
  await clearAgentLcmConversation(agentId).catch(() => undefined);
  await clearAgentMemory(agentId);
}
