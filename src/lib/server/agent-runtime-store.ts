import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { estimateAgentPromptTokens } from "./agent-prompt-token-estimate";
import { clearAgentMemory } from "./agent-memory-store";
import { loadWorkspaceEnvelope } from "./workspace-store";
import {
  appendAgentLcmMessage,
  assembleAgentLcmContext,
  clearAgentLcmConversation,
  compactAgentLcmContext,
  getAgentLcmStoredContextTokenCount,
  getAgentLcmRetrieval,
  getOrCreateAgentConversation,
} from "./lcm/facade";
import { runAfterCompactionHooks, runBeforeCompactionHooks } from "@/lib/ai/runtime-hooks";
import { DEFAULT_COMPACTION_TOKEN_THRESHOLD, coerceCompactionTokenThreshold } from "@/lib/chat/types";
import type { AssistantMessageMeta, MessageImageAttachment, ProviderCompatibility, RoomAgentId } from "@/lib/chat/types";
import { createUuid } from "@/lib/utils/uuid";

export type CompactionMethod = "llm" | "rule_fallback" | "unknown";

export interface CompactionRecordDetails {
  thresholdTokens: number;
  contextTokens: number;
  storedContextTokens: number;
  promptOverheadTokens: number;
  totalEstimatedTokens: number;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  attachmentTokens: number;
  result:
    | "compacted"
    | "below_threshold"
    | "empty_context"
    | "no_eligible_leaf_chunk"
    | "leaf_pass_failed"
    | "no_condensation_candidate"
    | "compaction_failed";
  contextTokensAfter?: number;
  storedContextTokensAfter?: number;
  tokensAfter?: number;
  totalEstimatedTokensAfter?: number;
}

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
  success: boolean;
  actionTaken: boolean;
  method: CompactionMethod;
  createdSummaryId?: string;
  summary: string;
  error?: string;
  prunedMessages: number;
  keptMessages: number;
  charsBefore: number;
  charsAfter: number;
  details?: CompactionRecordDetails;
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
    success: typeof value.success === "boolean" ? value.success : true,
    actionTaken: typeof value.actionTaken === "boolean" ? value.actionTaken : true,
    method: value.method === "llm" || value.method === "rule_fallback" || value.method === "unknown" ? value.method : "unknown",
    ...(typeof value.createdSummaryId === "string" && value.createdSummaryId ? { createdSummaryId: value.createdSummaryId } : {}),
    summary: typeof value.summary === "string" ? value.summary : "",
    ...(typeof value.error === "string" && value.error ? { error: value.error } : {}),
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
    ...(isRecord(value.details)
      ? {
          details: {
            thresholdTokens: typeof value.details.thresholdTokens === "number" ? Math.max(0, Math.round(value.details.thresholdTokens)) : 0,
            contextTokens: typeof value.details.contextTokens === "number" ? Math.max(0, Math.round(value.details.contextTokens)) : 0,
            storedContextTokens: typeof value.details.storedContextTokens === "number" ? Math.max(0, Math.round(value.details.storedContextTokens)) : 0,
            promptOverheadTokens: typeof value.details.promptOverheadTokens === "number" ? Math.max(0, Math.round(value.details.promptOverheadTokens)) : 0,
            totalEstimatedTokens: typeof value.details.totalEstimatedTokens === "number" ? Math.max(0, Math.round(value.details.totalEstimatedTokens)) : 0,
            systemPromptTokens: typeof value.details.systemPromptTokens === "number" ? Math.max(0, Math.round(value.details.systemPromptTokens)) : 0,
            toolSchemaTokens: typeof value.details.toolSchemaTokens === "number" ? Math.max(0, Math.round(value.details.toolSchemaTokens)) : 0,
            attachmentTokens: typeof value.details.attachmentTokens === "number" ? Math.max(0, Math.round(value.details.attachmentTokens)) : 0,
            result:
              value.details.result === "compacted"
              || value.details.result === "below_threshold"
              || value.details.result === "empty_context"
              || value.details.result === "no_eligible_leaf_chunk"
              || value.details.result === "leaf_pass_failed"
              || value.details.result === "no_condensation_candidate"
              || value.details.result === "compaction_failed"
                ? value.details.result
                : "compaction_failed",
            ...(typeof value.details.tokensAfter === "number" ? { tokensAfter: Math.max(0, Math.round(value.details.tokensAfter)) } : {}),
            ...(typeof value.details.contextTokensAfter === "number"
              ? { contextTokensAfter: Math.max(0, Math.round(value.details.contextTokensAfter)) }
              : {}),
            ...(typeof value.details.storedContextTokensAfter === "number"
              ? { storedContextTokensAfter: Math.max(0, Math.round(value.details.storedContextTokensAfter)) }
              : {}),
            ...(typeof value.details.totalEstimatedTokensAfter === "number"
              ? { totalEstimatedTokensAfter: Math.max(0, Math.round(value.details.totalEstimatedTokensAfter)) }
              : {}),
          },
        }
      : {}),
  };
}

function formatCompactionSkipReason(reason: CompactionRecordDetails["result"]): string {
  switch (reason) {
    case "below_threshold":
      return "未超过压缩阈值";
    case "empty_context":
      return "当前没有可压缩上下文";
    case "no_eligible_leaf_chunk":
      return "已超过阈值，但没有找到可压缩历史块";
    case "leaf_pass_failed":
      return "找到了候选历史块，但叶子压缩阶段未生成结果";
    case "no_condensation_candidate":
      return "叶子压缩后仍超阈值，但没有可继续凝缩的摘要块";
    case "compacted":
      return "已执行压缩";
    case "compaction_failed":
      return "压缩执行失败";
    default:
      return "压缩检查完成";
  }
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

export async function clearPersistedAgentCompactions(agentId: RoomAgentId): Promise<PersistedAgentRuntime> {
  const runtime = await readStoredRuntime(agentId);
  runtime.compactions = [];
  runtime.updatedAt = createTimestamp();
  await saveStoredRuntime(runtime);
  return runtime;
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
  const summaryModel = runtimeBefore.resolvedModel.trim() || undefined;
  const assembledPromptContext = await assembleAgentLcmContext(args.agentId, 20_000).catch(() => null);
  const storedContextTokens = await getAgentLcmStoredContextTokenCount(args.agentId).catch(() => null);
  const promptTokenEstimate = await estimateAgentPromptTokens({
    agentId: args.agentId,
    contextTokens: assembledPromptContext?.estimatedTokens ?? 0,
    history: runtimeBefore.history,
    systemPromptAddition: assembledPromptContext?.systemPromptAddition,
  }).catch(() => ({
    totalTokens: assembledPromptContext?.estimatedTokens ?? 0,
    contextTokens: assembledPromptContext?.estimatedTokens ?? 0,
    promptOverheadTokens: 0,
    systemPromptTokens: 0,
    toolSchemaTokens: 0,
    attachmentTokens: 0,
  }));
  const resolvedStoredContextTokens = typeof storedContextTokens === "number" && Number.isFinite(storedContextTokens)
    ? Math.max(0, Math.round(storedContextTokens))
    : promptTokenEstimate.contextTokens;
  const comparisonExtraTokens = promptTokenEstimate.totalTokens - resolvedStoredContextTokens;
  const lcmCompactionResult = await compactAgentLcmContext(
    args.agentId,
    compactionTokenThreshold,
    args.force,
    summaryModel,
    comparisonExtraTokens,
  ).then(
    (result) => ({ result, error: null as string | null }),
    (error) => ({ result: null, error: error instanceof Error ? error.message : "Unknown compaction failure." }),
  );
  const lcmCompaction = lcmCompactionResult.result;
  const baseDetails: CompactionRecordDetails = {
    thresholdTokens: compactionTokenThreshold,
    contextTokens: promptTokenEstimate.contextTokens,
    storedContextTokens: resolvedStoredContextTokens,
    promptOverheadTokens: promptTokenEstimate.promptOverheadTokens,
    totalEstimatedTokens: promptTokenEstimate.totalTokens,
    systemPromptTokens: promptTokenEstimate.systemPromptTokens,
    toolSchemaTokens: promptTokenEstimate.toolSchemaTokens,
    attachmentTokens: promptTokenEstimate.attachmentTokens,
    result: "compaction_failed",
  };
  if (!lcmCompaction) {
    const failureRecord: CompactionRecord = {
      id: createUuid(),
      createdAt: createTimestamp(),
      reason: args.reason,
      success: false,
      actionTaken: false,
      method: "unknown",
      summary: "",
      ...(lcmCompactionResult.error ? { error: lcmCompactionResult.error } : {}),
      prunedMessages: 0,
      keptMessages: runtimeBefore.history.length,
      charsBefore,
      charsAfter: charsBefore,
      details: baseDetails,
    };
    const runtime = await readStoredRuntime(args.agentId);
    runtime.compactions = [...runtime.compactions, failureRecord].slice(-MAX_COMPACTION_RECORDS);
    runtime.updatedAt = createTimestamp();
    await saveStoredRuntime(runtime);
    return {
      compacted: false,
      record: failureRecord,
      history: runtimeBefore.history,
    };
  }

  const lcmHistory = (await assembleLcmPersistedHistory(args.agentId)) ?? runtimeBefore.history;
  const charsAfter = estimateHistoryChars(lcmHistory);
  const assembledPromptContextAfter = await assembleAgentLcmContext(args.agentId, 20_000).catch(() => null);
  const promptTokenEstimateAfter = await estimateAgentPromptTokens({
    agentId: args.agentId,
    contextTokens: assembledPromptContextAfter?.estimatedTokens ?? 0,
    history: lcmHistory,
    systemPromptAddition: assembledPromptContextAfter?.systemPromptAddition,
  }).catch(() => null);
  const storedContextTokensAfter = lcmCompaction.tokensAfter;
  if (!lcmCompaction.actionTaken) {
    const runtime = await readStoredRuntime(args.agentId);
    const result = (lcmCompaction.skipReason ?? "no_eligible_leaf_chunk") as CompactionRecordDetails["result"];
    const skippedRecord: CompactionRecord = {
      id: createUuid(),
      createdAt: createTimestamp(),
      reason: args.reason,
      success: true,
      actionTaken: false,
      method: "unknown",
      summary: [
        `压缩检查结果：${formatCompactionSkipReason(result)}。`,
        `阈值 ${compactionTokenThreshold} tokens。`,
        `当前上下文 ${promptTokenEstimate.contextTokens} tokens。`,
        `系统/工具等固定开销 ${promptTokenEstimate.promptOverheadTokens} tokens（system ${promptTokenEstimate.systemPromptTokens} / tools ${promptTokenEstimate.toolSchemaTokens} / attachments ${promptTokenEstimate.attachmentTokens}）。`,
        `总估算 ${promptTokenEstimate.totalTokens} tokens。`,
      ].join("\n"),
      prunedMessages: 0,
      keptMessages: lcmHistory.length,
      charsBefore,
      charsAfter,
      details: {
        ...baseDetails,
        result,
        tokensAfter: lcmCompaction.tokensAfter,
        contextTokensAfter: promptTokenEstimateAfter?.contextTokens,
        storedContextTokensAfter,
        totalEstimatedTokensAfter: promptTokenEstimateAfter?.totalTokens,
      },
    };
    runtime.compactions = [...runtime.compactions, skippedRecord].slice(-MAX_COMPACTION_RECORDS);
    runtime.updatedAt = createTimestamp();
    await saveStoredRuntime(runtime);
    return { compacted: false, record: skippedRecord, history: lcmHistory };
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
  const method = summary.includes("[Compacted shared history summary]") || summary.includes("[压缩后的共享历史摘要]") ? "rule_fallback" : "llm";
  const record: CompactionRecord = {
    id: createUuid(),
    createdAt: createTimestamp(),
    reason: args.reason,
    success: true,
    actionTaken: true,
    method,
    ...(lcmCompaction.createdSummaryId ? { createdSummaryId: lcmCompaction.createdSummaryId } : {}),
    summary,
    prunedMessages: Math.max(0, runtimeBefore.history.length - lcmHistory.length),
    keptMessages: lcmHistory.length,
    charsBefore,
    charsAfter,
    details: {
      ...baseDetails,
      result: "compacted",
      tokensAfter: lcmCompaction.tokensAfter,
      contextTokensAfter: promptTokenEstimateAfter?.contextTokens,
      storedContextTokensAfter,
      totalEstimatedTokensAfter: promptTokenEstimateAfter?.totalTokens,
    },
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
