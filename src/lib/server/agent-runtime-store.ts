import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { clearAgentMemory } from "./agent-memory-store";
import { loadWorkspaceEnvelope } from "./workspace-store";
import {
  appendAgentLcmMessage,
  assembleAgentLcmContext,
  clearAgentLcmConversation,
  compactAgentLcmContext,
  getAgentLcmRetrieval,
  getOrCreateAgentConversation,
} from "./lcm/facade";
import { runAfterCompactionHooks, runBeforeCompactionHooks } from "@/lib/ai/runtime-hooks";
import { DEFAULT_COMPACTION_TOKEN_THRESHOLD, coerceCompactionTokenThreshold } from "@/lib/chat/types";
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
            typeof attachment === "object" &&
            attachment !== null &&
            (attachment as MessageImageAttachment).kind === "image" &&
            typeof (attachment as MessageImageAttachment).id === "string" &&
            typeof (attachment as MessageImageAttachment).mimeType === "string" &&
            typeof (attachment as MessageImageAttachment).filename === "string" &&
            typeof (attachment as MessageImageAttachment).sizeBytes === "number" &&
            typeof (attachment as MessageImageAttachment).storagePath === "string" &&
            typeof (attachment as MessageImageAttachment).url === "string",
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

async function readStoredRuntime(agentId: RoomAgentId): Promise<PersistedAgentRuntime> {
  await ensureRuntimeDir();
  const raw = await readFile(getRuntimeFilePath(agentId), "utf8").catch(() => "");
  if (!raw.trim()) {
    return createEmptyRuntime(agentId);
  }

  try {
    return normalizeRuntime(agentId, JSON.parse(raw) as unknown);
  } catch {
    return createEmptyRuntime(agentId);
  }
}

async function assembleLcmPersistedHistory(agentId: RoomAgentId): Promise<PersistedVisibleMessage[] | null> {
  const assembled = await assembleAgentLcmContext(agentId, 20_000);
  if (!assembled) {
    return null;
  }

  return assembled.messages.map((message, index) => ({
    id: `lcm-${index}-${createUuid()}`,
    role:
      message.role === "user" && typeof message.content === "string" && message.content.includes("<summary ")
        ? "assistant"
        : message.role === "user"
          ? "user"
          : "assistant",
    content:
      typeof message.content === "string" && message.content.includes("<summary ")
        ? extractSummaryText(message.content)
        : contentToText(message.content),
    attachments: [],
    createdAt: createTimestamp(),
  }));
}

async function resolveAgentCompactionTokenThreshold(agentId: RoomAgentId): Promise<number> {
  const workspace = await loadWorkspaceEnvelope().catch(() => null);
  return coerceCompactionTokenThreshold(workspace?.state.agentStates[agentId]?.settings.compactionTokenThreshold ?? DEFAULT_COMPACTION_TOKEN_THRESHOLD);
}

async function saveStoredRuntime(runtime: PersistedAgentRuntime): Promise<void> {
  await ensureRuntimeDir();
  await writeFile(
    getRuntimeFilePath(runtime.agentId),
    JSON.stringify(runtime, null, 2),
    "utf8",
  );
}

export async function loadPersistedAgentRuntime(agentId: RoomAgentId): Promise<PersistedAgentRuntime> {
  return readStoredRuntime(agentId);
}

export async function savePersistedAgentRuntime(runtime: PersistedAgentRuntime): Promise<void> {
  await saveStoredRuntime(normalizeRuntime(runtime.agentId, runtime));
}

export async function appendPersistedHistoryMessage(args: {
  agentId: RoomAgentId;
  message: Omit<PersistedVisibleMessage, "id" | "createdAt" | "attachments" | "meta"> & Partial<Pick<PersistedVisibleMessage, "id" | "createdAt" | "attachments" | "meta">>;
}): Promise<PersistedAgentRuntime> {
  const persistedMessage: PersistedVisibleMessage = {
    id: args.message.id ?? createUuid(),
    role: args.message.role,
    content: args.message.content,
    attachments: [...(args.message.attachments ?? [])],
    ...(args.message.meta ? { meta: args.message.meta } : {}),
    createdAt: args.message.createdAt || createTimestamp(),
  };

  await getOrCreateAgentConversation(args.agentId);
  await appendAgentLcmMessage({
    agentId: args.agentId,
    role: persistedMessage.role,
    content: persistedMessage.content,
    createdAt: persistedMessage.createdAt,
    parts: [
      {
        sessionId: `agent:${args.agentId}`,
        partType: "text",
        ordinal: 0,
        textContent: persistedMessage.content,
        metadata: JSON.stringify({
          originalRole: persistedMessage.role,
          rawType: "runtime_history_seed",
          attachments: persistedMessage.attachments,
          meta: persistedMessage.meta,
        }),
      },
    ],
  }).catch(() => undefined);

  const runtime = await readStoredRuntime(args.agentId);
  runtime.history = [...runtime.history, persistedMessage];
  runtime.updatedAt = createTimestamp();
  await saveStoredRuntime(runtime);
  return runtime;
}

export async function finalizePersistedAgentRuntime(args: {
  agentId: RoomAgentId;
  assistantMessage: PersistedVisibleMessage;
  resolvedModel: string;
  compatibility: ProviderCompatibility;
}): Promise<void> {
  const runtime = await readStoredRuntime(args.agentId);
  runtime.history = [...runtime.history, args.assistantMessage];
  runtime.resolvedModel = args.resolvedModel;
  runtime.compatibility = args.compatibility;
  runtime.updatedAt = createTimestamp();
  await saveStoredRuntime(runtime);
}

export async function compactPersistedAgentRuntime(args: {
  agentId: RoomAgentId;
  reason: "automatic" | "manual";
  force?: boolean;
}): Promise<CompactRuntimeResult> {
  const runtimeBefore = await readStoredRuntime(args.agentId);
  const charsBefore = estimateHistoryChars(runtimeBefore.history);
  const compactionTokenThreshold = await resolveAgentCompactionTokenThreshold(args.agentId);
  const lcmCompaction = await compactAgentLcmContext(args.agentId, compactionTokenThreshold, args.force).catch(() => null);
  if (!lcmCompaction) {
    return {
      compacted: false,
      history: runtimeBefore.history,
    };
  }

  const lcmHistory = (await assembleLcmPersistedHistory(args.agentId)) ?? runtimeBefore.history;
  const charsAfter = estimateHistoryChars(lcmHistory);
  if (!lcmCompaction.actionTaken) {
    const runtime = await readStoredRuntime(args.agentId);
    runtime.updatedAt = createTimestamp();
    await saveStoredRuntime(runtime);
    return { compacted: false, history: lcmHistory };
  }

  await runBeforeCompactionHooks({
    agentId: args.agentId,
    reason: args.reason,
    historyCount: runtimeBefore.history.length,
    charsBefore,
  });

  const describedSummary = lcmCompaction.createdSummaryId
    ? await getAgentLcmRetrieval(args.agentId)
        .then(({ retrieval }) => retrieval.describe(lcmCompaction.createdSummaryId!))
        .catch(() => null)
    : null;
  const summary =
    describedSummary?.summary?.content ||
    (lcmCompaction.createdSummaryId ? `LCM summary ${lcmCompaction.createdSummaryId}` : "LCM compaction");
  const record: CompactionRecord = {
    id: createUuid(),
    createdAt: createTimestamp(),
    reason: args.reason,
    summary,
    prunedMessages: Math.max(0, runtimeBefore.history.length - lcmHistory.length),
    keptMessages: lcmHistory.length,
    charsBefore,
    charsAfter,
  };

  const runtime = await readStoredRuntime(args.agentId);
  runtime.history = lcmHistory;
  runtime.compactions = [...runtime.compactions, record].slice(-MAX_COMPACTION_RECORDS);
  runtime.updatedAt = createTimestamp();
  await saveStoredRuntime(runtime);

  await runAfterCompactionHooks({
    agentId: args.agentId,
    reason: args.reason,
    historyCount: lcmHistory.length,
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

export async function resetPersistedAgentRuntime(agentId: RoomAgentId): Promise<void> {
  await rm(getRuntimeFilePath(agentId), { force: true });
  await clearAgentLcmConversation(agentId).catch(() => undefined);
  await clearAgentMemory(agentId);
}
