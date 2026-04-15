import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { estimateAgentPromptTokens } from "./agent-prompt-token-estimate";
import { generateCompactionSummary } from "./agent-compaction";
import { resolveAgentCompactionSettingsSelection } from "./agent-compaction-settings";
import { clearAgentMemory } from "./agent-memory-store";
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
import {
  type AssistantHistoryAssistantMessage,
  type AssistantHistoryMessage,
  type RoomMessageEmission,
  type RoomToolActionUnion,
  type ToolExecution,
} from "@/lib/chat/types";
import type { AssistantMessageMeta, MessageImageAttachment, ProviderCompatibility, RoomAgentId } from "@/lib/chat/types";
import { createUuid } from "@/lib/utils/uuid";
import { estimateTokens } from "./lcm/estimate-tokens";

const ROOM_KIND_LABELS: Record<RoomMessageEmission["kind"], string> = {
  answer: "answer",
  progress: "progress",
  warning: "warning",
  error: "error",
  clarification: "clarification",
};

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
    | "no_eligible_post_tool_prefix"
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
  reason: "post_turn" | "post_tool" | "manual";
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

export interface PromptCompactionTransformResult {
  compacted: boolean;
  summaryText?: string;
  keptStartIndex?: number;
  record?: CompactionRecord;
}

type PromptTokenEstimateResult = Awaited<ReturnType<typeof estimateAgentPromptTokens>>;

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
  if (
    !isRecord(value)
    || (value.reason !== "automatic" && value.reason !== "post_turn" && value.reason !== "post_tool" && value.reason !== "manual")
  ) {
    return null;
  }

  return {
    id: typeof value.id === "string" && value.id ? value.id : createUuid(),
    createdAt: typeof value.createdAt === "string" && value.createdAt ? value.createdAt : createTimestamp(),
    reason: value.reason === "automatic" ? "post_turn" : value.reason,
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
              || value.details.result === "no_eligible_post_tool_prefix"
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
    case "no_eligible_post_tool_prefix":
      return "tool 批次之前没有可压缩前缀";
    case "compacted":
      return "已执行压缩";
    case "compaction_failed":
      return "压缩执行失败";
    default:
      return "压缩检查完成";
  }
}

function createPromptTokenEstimateFallback(contextTokens: number): PromptTokenEstimateResult {
  return {
    totalTokens: contextTokens,
    contextTokens,
    promptOverheadTokens: 0,
    systemPromptTokens: 0,
    toolSchemaTokens: 0,
    attachmentTokens: 0,
  };
}

async function estimatePromptTokensWithFallback(
  args: Parameters<typeof estimateAgentPromptTokens>[0],
): Promise<PromptTokenEstimateResult> {
  return estimateAgentPromptTokens(args).catch(() => createPromptTokenEstimateFallback(args.contextTokens));
}

function createCompactionBaseDetails(args: {
  thresholdTokens: number;
  storedContextTokens: number;
  promptTokenEstimate: PromptTokenEstimateResult;
}): CompactionRecordDetails {
  return {
    thresholdTokens: args.thresholdTokens,
    contextTokens: args.promptTokenEstimate.contextTokens,
    storedContextTokens: args.storedContextTokens,
    promptOverheadTokens: args.promptTokenEstimate.promptOverheadTokens,
    totalEstimatedTokens: args.promptTokenEstimate.totalTokens,
    systemPromptTokens: args.promptTokenEstimate.systemPromptTokens,
    toolSchemaTokens: args.promptTokenEstimate.toolSchemaTokens,
    attachmentTokens: args.promptTokenEstimate.attachmentTokens,
    result: "compaction_failed",
  };
}

function withCompactionOutcomeDetails(args: {
  baseDetails: CompactionRecordDetails;
  result: CompactionRecordDetails["result"];
  tokensAfter?: number;
  contextTokensAfter?: number;
  storedContextTokensAfter?: number;
  totalEstimatedTokensAfter?: number;
}): CompactionRecordDetails {
  return {
    ...args.baseDetails,
    result: args.result,
    ...(typeof args.tokensAfter === "number" ? { tokensAfter: args.tokensAfter } : {}),
    ...(typeof args.contextTokensAfter === "number" ? { contextTokensAfter: args.contextTokensAfter } : {}),
    ...(typeof args.storedContextTokensAfter === "number" ? { storedContextTokensAfter: args.storedContextTokensAfter } : {}),
    ...(typeof args.totalEstimatedTokensAfter === "number" ? { totalEstimatedTokensAfter: args.totalEstimatedTokensAfter } : {}),
  };
}

function createCompactionSummary(args: {
  prefix: string;
  result: CompactionRecordDetails["result"];
  thresholdTokens: number;
  promptTokenEstimate: PromptTokenEstimateResult;
  includePromptOverhead: boolean;
}): string {
  const lines = [
    `${args.prefix}：${formatCompactionSkipReason(args.result)}。`,
    `阈值 ${args.thresholdTokens} tokens。`,
    `当前上下文 ${args.promptTokenEstimate.contextTokens} tokens。`,
  ];
  if (args.includePromptOverhead) {
    lines.push(
      `系统/工具等固定开销 ${args.promptTokenEstimate.promptOverheadTokens} tokens（system ${args.promptTokenEstimate.systemPromptTokens} / tools ${args.promptTokenEstimate.toolSchemaTokens} / attachments ${args.promptTokenEstimate.attachmentTokens}）。`,
    );
  }
  lines.push(`总估算 ${args.promptTokenEstimate.totalTokens} tokens。`);
  return lines.join("\n");
}

function createCompactionRecord(args: {
  reason: CompactionRecord["reason"];
  success: boolean;
  actionTaken: boolean;
  method: CompactionMethod;
  summary: string;
  error?: string;
  createdSummaryId?: string;
  prunedMessages: number;
  keptMessages: number;
  charsBefore: number;
  charsAfter: number;
  details?: CompactionRecordDetails;
}): CompactionRecord {
  return {
    id: createUuid(),
    createdAt: createTimestamp(),
    reason: args.reason,
    success: args.success,
    actionTaken: args.actionTaken,
    method: args.method,
    ...(args.createdSummaryId ? { createdSummaryId: args.createdSummaryId } : {}),
    summary: args.summary,
    ...(args.error ? { error: args.error } : {}),
    prunedMessages: args.prunedMessages,
    keptMessages: args.keptMessages,
    charsBefore: args.charsBefore,
    charsAfter: args.charsAfter,
    ...(args.details ? { details: args.details } : {}),
  };
}

function createSkippedCompactionRecord(args: {
  reason: CompactionRecord["reason"];
  result: CompactionRecordDetails["result"];
  summaryPrefix: string;
  thresholdTokens: number;
  promptTokenEstimate: PromptTokenEstimateResult;
  keptMessages: number;
  charsBefore: number;
  charsAfter: number;
  baseDetails: CompactionRecordDetails;
  tokensAfter?: number;
  contextTokensAfter?: number;
  storedContextTokensAfter?: number;
  totalEstimatedTokensAfter?: number;
  includePromptOverhead: boolean;
}): CompactionRecord {
  return createCompactionRecord({
    reason: args.reason,
    success: true,
    actionTaken: false,
    method: "unknown",
    summary: createCompactionSummary({
      prefix: args.summaryPrefix,
      result: args.result,
      thresholdTokens: args.thresholdTokens,
      promptTokenEstimate: args.promptTokenEstimate,
      includePromptOverhead: args.includePromptOverhead,
    }),
    prunedMessages: 0,
    keptMessages: args.keptMessages,
    charsBefore: args.charsBefore,
    charsAfter: args.charsAfter,
    details: withCompactionOutcomeDetails({
      baseDetails: args.baseDetails,
      result: args.result,
      tokensAfter: args.tokensAfter,
      contextTokensAfter: args.contextTokensAfter,
      storedContextTokensAfter: args.storedContextTokensAfter,
      totalEstimatedTokensAfter: args.totalEstimatedTokensAfter,
    }),
  });
}

function createFailedCompactionRecord(args: {
  reason: CompactionRecord["reason"];
  keptMessages: number;
  charsBefore: number;
  charsAfter: number;
  baseDetails: CompactionRecordDetails;
  error?: string;
}): CompactionRecord {
  return createCompactionRecord({
    reason: args.reason,
    success: false,
    actionTaken: false,
    method: "unknown",
    summary: "",
    ...(args.error ? { error: args.error } : {}),
    prunedMessages: 0,
    keptMessages: args.keptMessages,
    charsBefore: args.charsBefore,
    charsAfter: args.charsAfter,
    details: args.baseDetails,
  });
}

function detectCompactionMethod(summary: string): CompactionMethod {
  return summary.includes("[Compacted shared history summary]") || summary.includes("[压缩后的共享历史摘要]")
    ? "rule_fallback"
    : "llm";
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

function truncateToolResultSummary(value: string, maxLength = 260): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trim()}...`;
}

function extractToolEventFromSnapshotDetails(details: unknown): ToolExecution | null {
  if (!details || typeof details !== "object") {
    return null;
  }

  const toolEvent = (details as { toolEvent?: unknown }).toolEvent;
  if (!toolEvent || typeof toolEvent !== "object") {
    return null;
  }

  if (
    typeof (toolEvent as { toolName?: unknown }).toolName !== "string"
    || typeof (toolEvent as { displayName?: unknown }).displayName !== "string"
  ) {
    return null;
  }

  return toolEvent as ToolExecution;
}

function formatRoomActionForCompaction(action: RoomToolActionUnion): string {
  if (action.type === "read_no_reply") {
    return `${action.type} for room ${action.roomId}, message ${action.messageId}`;
  }

  if (action.type === "create_room") {
    return `${action.type} created room ${action.roomId} (${action.title}) with agents ${action.agentIds.join(", ") || "none"}`;
  }

  if (action.type === "add_agents_to_room") {
    return `${action.type} for room ${action.roomId}, agents ${action.agentIds.join(", ") || "none"}`;
  }

  if (action.type === "remove_room_participant") {
    return `${action.type} for room ${action.roomId}, participant ${action.participantId}`;
  }

  return `${action.type} for room ${action.roomId}`;
}

function buildPersistedToolResultSummary(toolEvent: ToolExecution): string {
  const sections: string[] = ["[Shared agent room action summary]"];

  if (toolEvent.roomMessage) {
    sections.push(
      [
        "Visible room deliveries:",
        `- to room ${toolEvent.roomMessage.roomId}: [${ROOM_KIND_LABELS[toolEvent.roomMessage.kind]} / ${toolEvent.roomMessage.status}${toolEvent.roomMessage.final ? " / final" : ""}] ${toolEvent.roomMessage.content}`,
      ].join("\n"),
    );
  }

  if (toolEvent.roomAction) {
    sections.push(["Room actions:", `- ${formatRoomActionForCompaction(toolEvent.roomAction)}`].join("\n"));
  }

  sections.push(
    [
      "Tool results used:",
      `- ${toolEvent.displayName}: ${truncateToolResultSummary(toolEvent.resultPreview || toolEvent.outputText || toolEvent.inputSummary || toolEvent.toolName)}`,
    ].join("\n"),
  );

  return sections.join("\n\n").trim();
}

function estimateSnapshotContentTokens(message: AssistantHistoryMessage): number {
  return estimateTokens(JSON.stringify(message.content));
}

function estimateSnapshotChars(message: AssistantHistoryMessage): number {
  return JSON.stringify(message.content).length;
}

function estimateSnapshotHistoryChars(historyDelta: AssistantHistoryMessage[]): number {
  return historyDelta.reduce((total, message) => total + estimateSnapshotChars(message), 0);
}

function estimateSnapshotHistoryContextTokens(historyDelta: AssistantHistoryMessage[]): number {
  return historyDelta.reduce((total, message) => total + estimateSnapshotContentTokens(message), 0);
}

function assistantTextPartsToString(parts: AssistantHistoryAssistantMessage["content"]): string {
  return parts
    .flatMap((part) => {
      if (part.type === "text") {
        return [part.text];
      }
      if (part.type === "toolCall") {
        return [`[Tool Call] ${part.name} ${JSON.stringify(part.arguments)}`];
      }
      return [];
    })
    .filter(Boolean)
    .join("\n");
}

function snapshotToPersistedVisibleMessage(message: AssistantHistoryMessage): PersistedVisibleMessage | null {
  if (message.role === "user") {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.map((part) => (part.type === "text" ? part.text : `[Image attachment: ${part.mimeType}]`)).join("\n");
    return {
      id: createUuid(),
      role: "user",
      content,
      attachments: [],
      createdAt: new Date(message.timestamp).toISOString(),
    };
  }

  if (message.role === "assistant") {
    return {
      id: createUuid(),
      role: "assistant",
      content: assistantTextPartsToString(message.content),
      attachments: [],
      createdAt: new Date(message.timestamp).toISOString(),
    };
  }

  const toolEvent = extractToolEventFromSnapshotDetails(message.details);
  return {
    id: createUuid(),
    role: "assistant",
    content: toolEvent
      ? buildPersistedToolResultSummary(toolEvent)
      : `[Tool Result] ${message.toolName}\n${contentToText(message.content)}`,
    attachments: [],
    createdAt: new Date(message.timestamp).toISOString(),
  };
}

function buildPromptHistoryFromSnapshots(historyDelta: AssistantHistoryMessage[]): Array<{ role: "user" | "assistant"; attachments?: MessageImageAttachment[] }> {
  return historyDelta.flatMap((message) => (message.role === "toolResult" ? [] : [{ role: message.role, attachments: [] }]));
}

function findLatestToolBatchStartIndex(historyDelta: AssistantHistoryMessage[]): number {
  for (let index = historyDelta.length - 1; index >= 0; index -= 1) {
    const message = historyDelta[index];
    if (message.role === "assistant" && message.content.some((part) => part.type === "toolCall")) {
      return index;
    }
  }
  return historyDelta.length;
}

function determinePostToolKeptStartIndex(historyDelta: AssistantHistoryMessage[], freshTailCount: number): number {
  const toolBatchStartIndex = findLatestToolBatchStartIndex(historyDelta);
  if (toolBatchStartIndex >= historyDelta.length) {
    return historyDelta.length;
  }

  if (freshTailCount <= 0) {
    return toolBatchStartIndex;
  }

  const rawIndexes = historyDelta
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role !== "toolResult")
    .map(({ index }) => index);
  if (rawIndexes.length === 0) {
    return toolBatchStartIndex;
  }

  const tailStartIndex = rawIndexes[Math.max(0, rawIndexes.length - freshTailCount)] ?? toolBatchStartIndex;
  return Math.min(toolBatchStartIndex, tailStartIndex);
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

async function saveStoredRuntime(runtime: PersistedAgentRuntime): Promise<void> {
  await ensureRuntimeDir();
  await writeFile(
    getRuntimeFilePath(runtime.agentId),
    JSON.stringify(runtime, null, 2),
    "utf8",
  );
}

async function appendCompactionRecord(agentId: RoomAgentId, record: CompactionRecord): Promise<void> {
  const runtime = await readStoredRuntime(agentId);
  runtime.compactions = [...runtime.compactions, record].slice(-MAX_COMPACTION_RECORDS);
  runtime.updatedAt = createTimestamp();
  await saveStoredRuntime(runtime);
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
  onTimingPhase?: (phase: string, details?: Record<string, unknown>) => void;
}): Promise<void> {
  const readStartedAt = performance.now();
  const runtime = await readStoredRuntime(args.agentId);
  args.onTimingPhase?.("finalize_runtime_read_stored", {
    durationMs: Math.max(0, performance.now() - readStartedAt),
    historyCountBefore: runtime.history.length,
  });
  runtime.history = [...runtime.history, args.assistantMessage];
  runtime.resolvedModel = args.resolvedModel;
  runtime.compatibility = args.compatibility;
  runtime.updatedAt = createTimestamp();
  const saveStartedAt = performance.now();
  await saveStoredRuntime(runtime);
  args.onTimingPhase?.("finalize_runtime_save_stored", {
    durationMs: Math.max(0, performance.now() - saveStartedAt),
    historyCountAfter: runtime.history.length,
    assistantChars: args.assistantMessage.content.length,
  });
}

export async function compactPersistedAgentRuntime(args: {
  agentId: RoomAgentId;
  reason: "post_turn" | "manual";
  force?: boolean;
}): Promise<CompactRuntimeResult> {
  const runtimeBefore = await readStoredRuntime(args.agentId);
  const charsBefore = estimateHistoryChars(runtimeBefore.history);
  const {
    thresholdTokens: compactionTokenThreshold,
    freshTailCount: compactionFreshTailCount,
    modelSelection,
  } = await resolveAgentCompactionSettingsSelection(args.agentId, runtimeBefore.resolvedModel.trim() || undefined);
  const assembledPromptContext = await assembleAgentLcmContext(args.agentId, 20_000).catch(() => null);
  const storedContextTokens = await getAgentLcmStoredContextTokenCount(args.agentId).catch(() => null);
  const promptTokenEstimate = await estimatePromptTokensWithFallback({
    agentId: args.agentId,
    contextTokens: assembledPromptContext?.estimatedTokens ?? 0,
    history: runtimeBefore.history,
    systemPromptAddition: assembledPromptContext?.systemPromptAddition,
  });
  const resolvedStoredContextTokens = typeof storedContextTokens === "number" && Number.isFinite(storedContextTokens)
    ? Math.max(0, Math.round(storedContextTokens))
    : promptTokenEstimate.contextTokens;
  const comparisonExtraTokens = promptTokenEstimate.totalTokens - resolvedStoredContextTokens;
  const lcmCompactionResult = await compactAgentLcmContext(
    args.agentId,
    compactionTokenThreshold,
    args.force,
    modelSelection,
    comparisonExtraTokens,
    compactionFreshTailCount,
  ).then(
    (result) => ({ result, error: null as string | null }),
    (error) => ({ result: null, error: error instanceof Error ? error.message : "Unknown compaction failure." }),
  );
  const lcmCompaction = lcmCompactionResult.result;
  const baseDetails = createCompactionBaseDetails({
    thresholdTokens: compactionTokenThreshold,
    storedContextTokens: resolvedStoredContextTokens,
    promptTokenEstimate,
  });
  if (!lcmCompaction) {
    const failureRecord = createFailedCompactionRecord({
      reason: args.reason,
      keptMessages: runtimeBefore.history.length,
      charsBefore,
      charsAfter: charsBefore,
      baseDetails,
      error: lcmCompactionResult.error ?? undefined,
    });
    await appendCompactionRecord(args.agentId, failureRecord);
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
    const result = (lcmCompaction.skipReason ?? "no_eligible_leaf_chunk") as CompactionRecordDetails["result"];
    const skippedRecord = createSkippedCompactionRecord({
      reason: args.reason,
      result,
      summaryPrefix: "压缩检查结果",
      thresholdTokens: compactionTokenThreshold,
      promptTokenEstimate,
      keptMessages: lcmHistory.length,
      charsBefore,
      charsAfter,
      baseDetails,
      tokensAfter: lcmCompaction.tokensAfter,
      contextTokensAfter: promptTokenEstimateAfter?.contextTokens,
      storedContextTokensAfter,
      totalEstimatedTokensAfter: promptTokenEstimateAfter?.totalTokens,
      includePromptOverhead: true,
    });
    await appendCompactionRecord(args.agentId, skippedRecord);
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
  const record = createCompactionRecord({
    reason: args.reason,
    success: true,
    actionTaken: true,
    method: detectCompactionMethod(summary),
    createdSummaryId: lcmCompaction.createdSummaryId,
    summary,
    prunedMessages: Math.max(0, runtimeBefore.history.length - lcmHistory.length),
    keptMessages: lcmHistory.length,
    charsBefore,
    charsAfter,
    details: withCompactionOutcomeDetails({
      baseDetails,
      result: "compacted",
      tokensAfter: lcmCompaction.tokensAfter,
      contextTokensAfter: promptTokenEstimateAfter?.contextTokens,
      storedContextTokensAfter,
      totalEstimatedTokensAfter: promptTokenEstimateAfter?.totalTokens,
    }),
  });

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

export async function compactPromptHistoryAfterToolBatch(args: {
  agentId: RoomAgentId;
  historyDelta: AssistantHistoryMessage[];
  resolvedModel: string;
  signal?: AbortSignal;
}): Promise<PromptCompactionTransformResult> {
  const charsBefore = estimateSnapshotHistoryChars(args.historyDelta);
  const contextTokens = estimateSnapshotHistoryContextTokens(args.historyDelta);
  const { thresholdTokens, freshTailCount, modelSelection } = await resolveAgentCompactionSettingsSelection(
    args.agentId,
    args.resolvedModel,
  );
  const keptStartIndex = determinePostToolKeptStartIndex(args.historyDelta, freshTailCount);
  const promptTokenEstimate = await estimatePromptTokensWithFallback({
    agentId: args.agentId,
    contextTokens,
    history: buildPromptHistoryFromSnapshots(args.historyDelta),
  });
  const baseDetails = createCompactionBaseDetails({
    thresholdTokens,
    storedContextTokens: promptTokenEstimate.contextTokens,
    promptTokenEstimate,
  });

  if (promptTokenEstimate.totalTokens <= thresholdTokens) {
    const record = createSkippedCompactionRecord({
      reason: "post_tool",
      result: "below_threshold",
      summaryPrefix: "tool 批次后压缩检查结果",
      thresholdTokens,
      promptTokenEstimate,
      keptMessages: args.historyDelta.length,
      charsBefore,
      charsAfter: charsBefore,
      baseDetails,
      tokensAfter: promptTokenEstimate.contextTokens,
      contextTokensAfter: promptTokenEstimate.contextTokens,
      storedContextTokensAfter: promptTokenEstimate.contextTokens,
      totalEstimatedTokensAfter: promptTokenEstimate.totalTokens,
      includePromptOverhead: true,
    });
    await appendCompactionRecord(args.agentId, record);
    return { compacted: false, record };
  }

  if (keptStartIndex <= 0 || keptStartIndex >= args.historyDelta.length) {
    const record = createSkippedCompactionRecord({
      reason: "post_tool",
      result: "no_eligible_post_tool_prefix",
      summaryPrefix: "tool 批次后压缩检查结果",
      thresholdTokens,
      promptTokenEstimate,
      keptMessages: args.historyDelta.length,
      charsBefore,
      charsAfter: charsBefore,
      baseDetails,
      tokensAfter: promptTokenEstimate.contextTokens,
      contextTokensAfter: promptTokenEstimate.contextTokens,
      storedContextTokensAfter: promptTokenEstimate.contextTokens,
      totalEstimatedTokensAfter: promptTokenEstimate.totalTokens,
      includePromptOverhead: false,
    });
    await appendCompactionRecord(args.agentId, record);
    return { compacted: false, record };
  }

  const prunedSnapshots = args.historyDelta.slice(0, keptStartIndex);
  const keptSnapshots = args.historyDelta.slice(keptStartIndex);
  const compactionMessages = prunedSnapshots
    .map((message) => snapshotToPersistedVisibleMessage(message))
    .filter((message): message is PersistedVisibleMessage => Boolean(message));
  if (compactionMessages.length === 0) {
    const record = createSkippedCompactionRecord({
      reason: "post_tool",
      result: "no_eligible_post_tool_prefix",
      summaryPrefix: "tool 批次后压缩检查结果",
      thresholdTokens,
      promptTokenEstimate,
      keptMessages: args.historyDelta.length,
      charsBefore,
      charsAfter: charsBefore,
      baseDetails,
      tokensAfter: promptTokenEstimate.contextTokens,
      contextTokensAfter: promptTokenEstimate.contextTokens,
      storedContextTokensAfter: promptTokenEstimate.contextTokens,
      totalEstimatedTokensAfter: promptTokenEstimate.totalTokens,
      includePromptOverhead: false,
    });
    await appendCompactionRecord(args.agentId, record);
    return { compacted: false, record };
  }

  try {
    const summaryText = await generateCompactionSummary({
      agentId: args.agentId,
      messages: compactionMessages,
      resolvedModel: modelSelection.resolvedModel,
      settings: modelSelection.settings,
      modelConfigOverrides: modelSelection.modelConfigOverrides,
      signal: args.signal,
    });
    const method = detectCompactionMethod(summaryText);
    const compactedSnapshots: AssistantHistoryMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: summaryText }],
        api: "internal",
        provider: "internal",
        model: modelSelection.resolvedModel || "internal/post_tool_compaction",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: args.historyDelta[Math.max(0, keptStartIndex - 1)]?.timestamp ?? Date.now(),
      } satisfies AssistantHistoryAssistantMessage,
      ...keptSnapshots,
    ];
    const charsAfter = estimateSnapshotHistoryChars(compactedSnapshots);
    const contextTokensAfter = estimateSnapshotHistoryContextTokens(compactedSnapshots);
    const promptTokenEstimateAfter = await estimateAgentPromptTokens({
      agentId: args.agentId,
      contextTokens: contextTokensAfter,
      history: buildPromptHistoryFromSnapshots(compactedSnapshots),
    }).catch(() => null);
    const record = createCompactionRecord({
      reason: "post_tool",
      success: true,
      actionTaken: true,
      method,
      summary: summaryText,
      prunedMessages: prunedSnapshots.length,
      keptMessages: compactedSnapshots.length,
      charsBefore,
      charsAfter,
      details: withCompactionOutcomeDetails({
        baseDetails,
        result: "compacted",
        tokensAfter: contextTokensAfter,
        contextTokensAfter,
        storedContextTokensAfter: contextTokensAfter,
        totalEstimatedTokensAfter: promptTokenEstimateAfter?.totalTokens ?? contextTokensAfter,
      }),
    });
    await appendCompactionRecord(args.agentId, record);
    return {
      compacted: true,
      summaryText,
      keptStartIndex,
      record,
    };
  } catch (error) {
    const record = createFailedCompactionRecord({
      reason: "post_tool",
      keptMessages: args.historyDelta.length,
      charsBefore,
      charsAfter: charsBefore,
      baseDetails,
      error: error instanceof Error ? error.message : undefined,
    });
    await appendCompactionRecord(args.agentId, record);
    return { compacted: false, record };
  }
}

export async function resetPersistedAgentRuntime(agentId: RoomAgentId): Promise<void> {
  await rm(getRuntimeFilePath(agentId), { force: true });
  await clearAgentLcmConversation(agentId).catch(() => undefined);
  await clearAgentMemory(agentId);
}
