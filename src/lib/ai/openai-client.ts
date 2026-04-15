import { createHash } from "node:crypto";
import { Agent, type AgentEvent, type ThinkingLevel as PiAgentThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, Usage, UserMessage } from "@mariozechner/pi-ai";
import {
  getResponsesContinuationOrder,
  shouldFallbackToResponsesReplay,
} from "@/lib/ai/provider-compat";
import { ensureOpenAiFetchCompatibility } from "@/lib/ai/openai-fetch-compat";
import { shouldApplyPostToolBatchCompaction } from "@/lib/ai/post-tool-compaction";
import {
  createPostToolCompactionTimeoutController,
  createPostToolStallAbortController,
  createToolCallStallAbortController,
} from "@/lib/ai/post-tool-stall";
import { extractRoomMessagePreviewFromToolCallBlock } from "@/lib/ai/room-message-preview";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { resolvePiModel } from "@/lib/ai/pi-model-resolver";
import { getPiAgentTools, type PiToolResultDetails } from "@/lib/ai/pi-agent-tools";
import { runBeforeModelResolveHooks, runBeforePromptBuildHooks } from "@/lib/ai/runtime-hooks";
import { readStoredImageAttachment } from "@/lib/server/image-upload-store";
import { ensureGlobalProxyDispatcherInstalled } from "@/lib/server/proxy-fetch";
import type {
  ApiFormat,
  AssistantContinuationSnapshot,
  AssistantHistoryMessage,
  AssistantHistoryUsageSnapshot,
  AssistantMessageMeta,
  AssistantUsageSnapshot,
  ChatMessage,
  ChatSettings,
  EmptyCompletionDiagnostic,
  ModelConfigExecutionOverrides,
  ProviderCompatibility,
  RecoveryDiagnostic,
  RoomMessagePreviewEmission,
  RoomToolContext,
  ThinkingLevel,
  ToolExecution,
  ToolScope,
} from "@/lib/chat/types";
import { coerceMaxToolLoopSteps } from "@/lib/chat/types";

type VisibleMessage = Pick<ChatMessage, "role" | "content" | "attachments" | "meta">;

type ResponsesContinuationStrategy = "replay" | "previous_response_id";

type PayloadRecord = Record<string, unknown>;

const FINAL_ROOM_DELIVERY_SHORT_CIRCUIT_MS = 50;
function toPiAgentThinkingLevel(level: ThinkingLevel): PiAgentThinkingLevel {
  // pi-agent-core types lag OpenAI's current `none` effort value, but the
  // runtime forwards any non-`off` string as provider reasoning effort.
  return level as PiAgentThinkingLevel;
}

interface RunConversationResult {
  assistantText: string;
  toolEvents: ToolExecution[];
  resolvedModel: string;
  compatibility: ProviderCompatibility;
  actualApiFormat: ApiFormat;
  responseId?: string;
  sessionId?: string;
  continuation?: AssistantContinuationSnapshot;
  usage?: AssistantUsageSnapshot;
  historyDelta?: AssistantHistoryMessage[];
  emptyCompletion?: EmptyCompletionDiagnostic;
  recovery?: RecoveryDiagnostic;
}

interface RunTextPromptResult {
  assistantText: string;
  resolvedModel: string;
  compatibility: ProviderCompatibility;
  actualApiFormat: ApiFormat;
  responseId?: string;
  sessionId?: string;
  usage?: AssistantUsageSnapshot;
}

interface ResponsesContinuationContext {
  previousResponseId: string;
  messages: VisibleMessage[];
}

interface StreamConversationCallbacks {
  onTextDelta?: (delta: string) => void;
  onTool?: (tool: ToolExecution) => void;
  onRoomMessagePreview?: (preview: RoomMessagePreviewEmission) => void;
}

interface PostToolBatchCompactionContext {
  historyDelta: AssistantHistoryMessage[];
  resolvedModel: string;
  signal?: AbortSignal;
}

interface PostToolBatchCompactionResult {
  summaryText: string;
  keptStartIndex: number;
}

interface ConversationOptions {
  toolScope?: ToolScope;
  systemPromptOverride?: string;
  maxToolLoopSteps?: number;
  signal?: AbortSignal;
  toolContext?: RoomToolContext;
  modelConfigOverrides?: ModelConfigExecutionOverrides;
  postToolBatchCompaction?: (context: PostToolBatchCompactionContext) => Promise<PostToolBatchCompactionResult | null>;
}

class ConversationExecutionError extends Error {
  assistantMeta?: AssistantMessageMeta;

  constructor(message: string, assistantMeta?: AssistantMessageMeta) {
    super(message);
    this.name = "ConversationExecutionError";
    this.assistantMeta = assistantMeta;
  }
}

function resolveConversationOptions(options?: ConversationOptions): {
  toolScope: ToolScope;
  systemPromptOverride: string;
  maxToolLoopSteps: number;
  signal?: AbortSignal;
  toolContext?: RoomToolContext;
  modelConfigOverrides?: ModelConfigExecutionOverrides;
  postToolBatchCompaction?: ConversationOptions["postToolBatchCompaction"];
} {
  return {
    toolScope: options?.toolScope || "default",
    systemPromptOverride: options?.systemPromptOverride || "",
    maxToolLoopSteps: coerceMaxToolLoopSteps(options?.maxToolLoopSteps),
    signal: options?.signal,
    toolContext: options?.toolContext,
    modelConfigOverrides: options?.modelConfigOverrides,
    postToolBatchCompaction: options?.postToolBatchCompaction,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  throw signal.reason instanceof Error ? signal.reason : new Error("The request was aborted.");
}

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createSyntheticSummaryMessage(args: {
  summaryText: string;
  resolvedModel: ReturnType<typeof resolvePiModel>;
  timestamp: number;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: args.summaryText }],
    api: args.resolvedModel.model.api,
    provider: args.resolvedModel.model.provider,
    model: args.resolvedModel.model.id,
    usage: createUsage(),
    stopReason: "stop",
    timestamp: args.timestamp,
  };
}

function shouldSendSessionHeader(baseUrl: string): boolean {
  return baseUrl.toLowerCase().includes("right.codes");
}

function sanitizeSessionIdPart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9:_-]+/g, "-").replace(/-+/g, "-").replace(/^[-:]+|[-:]+$/g, "");
  return sanitized || "unknown";
}

function buildStableSessionId(args: {
  resolvedModel: ReturnType<typeof resolvePiModel>;
  toolContext?: RoomToolContext;
}): string | undefined {
  const roomId = args.toolContext?.currentRoomId?.trim();
  const agentId = args.toolContext?.currentAgentId?.trim();
  if (!roomId || !agentId) {
    return undefined;
  }

  return [
    "room",
    sanitizeSessionIdPart(roomId),
    "agent",
    sanitizeSessionIdPart(agentId),
    "provider",
    sanitizeSessionIdPart(args.resolvedModel.compatibility.providerKey),
    "api",
    sanitizeSessionIdPart(args.resolvedModel.actualApiFormat),
    "model",
    sanitizeSessionIdPart(args.resolvedModel.resolvedModelRef || args.resolvedModel.model.id),
  ].join(":");
}

function buildProviderSessionKey(sessionId: string | undefined): string | undefined {
  if (!sessionId?.trim()) {
    return undefined;
  }

  const normalized = sanitizeSessionIdPart(sessionId);
  if (normalized.length <= 64) {
    return normalized;
  }

  const digest = createHash("sha1").update(normalized).digest("hex").slice(0, 16);
  return `${normalized.slice(0, 47)}:${digest}`;
}

function getToolCallProgressSignature(args: {
  name: string;
  arguments: unknown;
  partialJson?: unknown;
}): string {
  if (typeof args.partialJson === "string") {
    return `${args.name}:${args.partialJson}`;
  }

  try {
    return `${args.name}:${JSON.stringify(args.arguments)}`;
  } catch {
    return `${args.name}:${String(args.arguments)}`;
  }
}

function createHistoricalAssistantMessage(message: VisibleMessage, model: Model<Api>, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: message.content.trim()
      ? [
          {
            type: "text",
            text: message.content,
          },
        ]
      : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    ...(message.meta?.responseId
      ? {
          responseId: message.meta.responseId,
        }
      : {}),
    usage: createUsage(),
    stopReason: "stop",
    timestamp,
  };
}

function toHistoryUsageSnapshot(usage: Usage): AssistantHistoryUsageSnapshot {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

function restoreUsageSnapshot(snapshot: AssistantHistoryUsageSnapshot | undefined): Usage {
  if (!snapshot) {
    return createUsage();
  }

  return {
    input: snapshot.input,
    output: snapshot.output,
    cacheRead: snapshot.cacheRead,
    cacheWrite: snapshot.cacheWrite,
    totalTokens: snapshot.totalTokens,
    cost: {
      input: snapshot.cost.input,
      output: snapshot.cost.output,
      cacheRead: snapshot.cost.cacheRead,
      cacheWrite: snapshot.cost.cacheWrite,
      total: snapshot.cost.total,
    },
  };
}

function snapshotHistoryMessage(message: Message): AssistantHistoryMessage | null {
  if (message.role === "user") {
    return {
      role: "user",
      content: typeof message.content === "string"
        ? message.content
        : message.content.flatMap((item) => item.type === "text" || item.type === "image" ? [item] : []),
      timestamp: message.timestamp,
    };
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content.flatMap((item) => item.type === "text" || item.type === "thinking" || item.type === "toolCall" ? [item] : []),
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...(message.responseId
        ? {
            responseId: message.responseId,
          }
        : {}),
      usage: toHistoryUsageSnapshot(message.usage),
      stopReason: message.stopReason,
      ...(message.errorMessage
        ? {
            errorMessage: message.errorMessage,
          }
        : {}),
      timestamp: message.timestamp,
    };
  }

  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content.flatMap((item) => item.type === "text" || item.type === "image" ? [item] : []),
      ...(typeof message.details !== "undefined"
        ? {
            details: message.details,
          }
        : {}),
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }

  return null;
}

function snapshotHistoryDelta(messages: Message[]): AssistantHistoryMessage[] | undefined {
  const historyDelta = messages.flatMap((message) => {
    const snapshot = snapshotHistoryMessage(message);
    return snapshot ? [snapshot] : [];
  });

  return historyDelta.length > 0 ? historyDelta : undefined;
}

function restoreHistoryMessage(snapshot: AssistantHistoryMessage): Message | null {
  if (snapshot.role === "user") {
    return {
      role: "user",
      content: snapshot.content,
      timestamp: snapshot.timestamp,
    } satisfies UserMessage;
  }

  if (snapshot.role === "assistant") {
    return {
      role: "assistant",
      content: snapshot.content,
      api: snapshot.api as Api,
      provider: snapshot.provider,
      model: snapshot.model,
      ...(snapshot.responseId
        ? {
            responseId: snapshot.responseId,
          }
        : {}),
      usage: restoreUsageSnapshot(snapshot.usage),
      stopReason: snapshot.stopReason,
      ...(snapshot.errorMessage
        ? {
            errorMessage: snapshot.errorMessage,
          }
        : {}),
      timestamp: snapshot.timestamp,
    } satisfies AssistantMessage;
  }

  if (snapshot.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: snapshot.toolCallId,
      toolName: snapshot.toolName,
      content: snapshot.content,
      ...(typeof snapshot.details !== "undefined"
        ? {
            details: snapshot.details,
          }
        : {}),
      isError: snapshot.isError,
      timestamp: snapshot.timestamp,
    };
  }

  return null;
}

function restoreHistoryDelta(historyDelta: AssistantHistoryMessage[] | undefined): Message[] {
  if (!historyDelta?.length) {
    return [];
  }

  return historyDelta.flatMap((snapshot) => {
    const message = restoreHistoryMessage(snapshot);
    return message ? [message] : [];
  });
}

function toAssistantUsageSnapshot(usage: Usage | undefined): AssistantUsageSnapshot | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
}

function isPayloadRecord(value: unknown): value is PayloadRecord {
  return typeof value === "object" && value !== null;
}

function isPayloadMessageWithRole(value: unknown): value is { role: string } {
  return isPayloadRecord(value) && typeof value.role === "string";
}

function resolveResponsesContinuationContext(
  messages: VisibleMessage[],
  compatibility: ProviderCompatibility,
): ResponsesContinuationContext | null {
  if (messages.length < 2) {
    return null;
  }

  let lastAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }

  if (lastAssistantIndex < 0 || lastAssistantIndex >= messages.length - 1) {
    return null;
  }

  const assistantMessage = messages[lastAssistantIndex];
  const responseId = assistantMessage.meta?.responseId?.trim();
  if (!responseId || assistantMessage.meta?.apiFormat !== "responses") {
    return null;
  }

  if (
    assistantMessage.meta.compatibility.providerKey !== compatibility.providerKey
    || assistantMessage.meta.compatibility.baseUrl !== compatibility.baseUrl
  ) {
    return null;
  }

  const followUpMessages = messages.slice(lastAssistantIndex + 1);
  if (followUpMessages.length === 0 || followUpMessages.some((message) => message.role !== "user")) {
    return null;
  }

  return {
    previousResponseId: responseId,
    messages: followUpMessages,
  };
}

function applyPreviousResponseIdToPayload(
  payload: unknown,
  previousResponseId: string,
  systemPrompt: string,
): unknown {
  if (!isPayloadRecord(payload)) {
    return payload;
  }

  const input = Array.isArray(payload.input)
    ? payload.input.filter((item) => !isPayloadMessageWithRole(item) || (item.role !== "developer" && item.role !== "system"))
    : payload.input;

  return {
    ...payload,
    input,
    previous_response_id: previousResponseId,
    ...(systemPrompt.trim()
      ? {
          instructions: systemPrompt,
        }
      : {}),
  };
}

function applyResponsesPayloadOverrides(args: {
  payload: unknown;
  promptCacheKey?: string;
  previousResponseId?: string;
  systemPrompt: string;
}): unknown {
  let nextPayload = args.payload;

  if (args.previousResponseId) {
    nextPayload = applyPreviousResponseIdToPayload(nextPayload, args.previousResponseId, args.systemPrompt);
  }

  if (!isPayloadRecord(nextPayload) || !args.promptCacheKey?.trim()) {
    return nextPayload;
  }

  return {
    ...nextPayload,
    prompt_cache_key: args.promptCacheKey,
  };
}

async function createUserMessageContent(message: VisibleMessage): Promise<UserMessage["content"]> {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return message.content;
  }

  const blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  if (message.content.trim()) {
    blocks.push({
      type: "text",
      text: message.content,
    });
  }

  const imageBlocks = await Promise.all(
    attachments.map(async (attachment) => ({
      type: "image" as const,
      data: (await readStoredImageAttachment(attachment)).toString("base64"),
      mimeType: attachment.mimeType,
    })),
  );

  return [...blocks, ...imageBlocks];
}

async function createConversationHistory(messages: VisibleMessage[], model: Model<Api>): Promise<Message[]> {
  const startTimestamp = Date.now() - Math.max(messages.length, 1) * 1_000;
  const history = await Promise.all(messages.map(async (message, index) => {
    const timestamp = startTimestamp + index * 1_000;
    if (message.role === "user") {
      return [{
        role: "user",
        content: await createUserMessageContent(message),
        timestamp,
      } satisfies Message];
    }

    const restoredHistory = restoreHistoryDelta(message.meta?.historyDelta);
    if (restoredHistory.length > 0) {
      return restoredHistory;
    }

    return [createHistoricalAssistantMessage(message, model, timestamp)];
  }));

  return history.flat();
}

function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === "assistant";
}

function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((item): item is Extract<AssistantMessage["content"][number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n\n")
    .trim();
}

function extractToolExecution(event: AgentEvent): ToolExecution | null {
  if (event.type !== "tool_execution_end") {
    return null;
  }

  const details = event.result.details;
  if (!details || typeof details !== "object" || !("toolEvent" in details)) {
    return null;
  }

  return (details as PiToolResultDetails).toolEvent;
}

function createConversationError(message: string, apiFormat: ApiFormat, compatibility: ProviderCompatibility): ConversationExecutionError {
  return new ConversationExecutionError(message, {
    apiFormat,
    compatibility,
  });
}

function readErrorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 5 || !error || typeof error !== "object") {
    return undefined;
  }

  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }

  if ("cause" in error) {
    return readErrorCode(error.cause, depth + 1);
  }

  return undefined;
}

function collectErrorMessages(error: unknown, depth = 0): string[] {
  if (depth > 5 || !error) {
    return [];
  }

  if (typeof error === "string") {
    return [error];
  }

  if (!(error instanceof Error)) {
    if (typeof error === "object" && "cause" in error) {
      return collectErrorMessages(error.cause, depth + 1);
    }

    return [];
  }

  const messages = error.message ? [error.message] : [];
  return messages.concat(collectErrorMessages(error.cause, depth + 1));
}

function normalizeConversationFailure(error: unknown, fallback: string): string {
  const code = readErrorCode(error);
  const combinedMessages = collectErrorMessages(error)
    .join("\n")
    .toUpperCase();

  if (code === "UND_ERR_CONNECT_TIMEOUT" || combinedMessages.includes("UND_ERR_CONNECT_TIMEOUT")) {
    return "Timed out while connecting to the model endpoint. This machine may need `HTTPS_PROXY` or `HTTP_PROXY` configured.";
  }

  if (
    code === "ECONNREFUSED"
    || code === "ENETUNREACH"
    || code === "EHOSTUNREACH"
    || combinedMessages.includes("ECONNREFUSED")
    || combinedMessages.includes("ENETUNREACH")
    || combinedMessages.includes("EHOSTUNREACH")
  ) {
    return "The upstream model endpoint is unreachable from this machine. Check network access, proxy settings, and the configured base URL.";
  }

  return fallback;
}

function getGeneratedAssistantMessages(messages: Message[]): AssistantMessage[] {
  return messages.filter(isAssistantMessage);
}

function shouldShortCircuitAfterFinalRoomDelivery(tool: ToolExecution, currentRoomId: string | undefined): boolean {
  const roomId = currentRoomId?.trim();
  if (!roomId) {
    return false;
  }

  return tool.toolName === "send_message_to_room"
    && tool.status === "success"
    && tool.roomMessage?.roomId === roomId
    && tool.roomMessage.status === "completed"
    && tool.roomMessage.final === true
    && tool.roomMessage.content.trim().length > 0;
}

async function runConversationAttempt(args: {
  messages: VisibleMessage[];
  resolvedModel: ReturnType<typeof resolvePiModel>;
  systemPromptText: string;
  callbacks?: StreamConversationCallbacks;
  resolvedOptions: ReturnType<typeof resolveConversationOptions>;
  continuationStrategy: ResponsesContinuationStrategy;
  sessionId?: string;
}): Promise<RunConversationResult> {
  ensureOpenAiFetchCompatibility(args.resolvedModel.compatibility.baseUrl);
  const responsesContinuation = args.continuationStrategy === "previous_response_id"
    ? resolveResponsesContinuationContext(args.messages, args.resolvedModel.compatibility)
    : null;
  const historyMessages = responsesContinuation?.messages ?? args.messages;
  const providerSessionKey = buildProviderSessionKey(args.sessionId);
  const model = providerSessionKey && shouldSendSessionHeader(args.resolvedModel.compatibility.baseUrl)
    ? {
        ...args.resolvedModel.model,
        headers: {
          ...((args.resolvedModel.model as { headers?: Record<string, string> }).headers ?? {}),
          session_id: providerSessionKey,
        },
      }
    : args.resolvedModel.model;
  let pendingPostToolBatchCompaction = false;
  const postToolStallAbort = createPostToolStallAbortController({
    abort: () => agent.abort(),
  });
  const toolCallStallAbort = createToolCallStallAbortController({
    abort: () => agent.abort(),
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: args.systemPromptText,
      model,
      thinkingLevel: toPiAgentThinkingLevel(args.resolvedModel.actualThinkingLevel),
      tools: getPiAgentTools(args.resolvedOptions.toolScope, args.resolvedOptions.toolContext),
      messages: await createConversationHistory(historyMessages, model),
    },
    getApiKey: args.resolvedModel.apiKey
      ? async () => args.resolvedModel.apiKey
      : undefined,
    sessionId: args.sessionId,
    onPayload: async (payload: unknown) =>
      applyResponsesPayloadOverrides({
        payload,
        promptCacheKey: providerSessionKey,
        previousResponseId: responsesContinuation?.previousResponseId,
        systemPrompt: args.systemPromptText,
      }),
    transformContext: async (messages: Message[], signal?: AbortSignal) => {
      const postToolBatchCompaction = args.resolvedOptions.postToolBatchCompaction;
      if (!shouldApplyPostToolBatchCompaction({
        pendingPostToolBatchCompaction,
        hasPostToolBatchCompactionHandler: Boolean(postToolBatchCompaction),
        finalRoomDeliveryShortCircuitArmed,
      })) {
        if (finalRoomDeliveryShortCircuitArmed) {
          pendingPostToolBatchCompaction = false;
        }
        return messages;
      }
      if (!postToolBatchCompaction) {
        return messages;
      }

      pendingPostToolBatchCompaction = false;
      const historyDelta = snapshotHistoryDelta(messages);
      if (!historyDelta?.length) {
        return messages;
      }

      // Post-tool compaction can consume most of the stall budget on its own, so
      // pause the watchdog and re-arm it only once the follow-up model request is
      // actually ready to continue.
      postToolStallAbort.pause();
      let shouldResumePostToolStallAbort = true;
      const postToolCompactionTimeout = createPostToolCompactionTimeoutController({ signal });
      try {
        const compaction = await postToolBatchCompaction({
          historyDelta,
          resolvedModel: args.resolvedModel.resolvedModelRef,
          signal: postToolCompactionTimeout.signal,
        });
        if (postToolCompactionTimeout.timedOut()) {
          return messages;
        }
        if (!compaction || !compaction.summaryText.trim()) {
          return messages;
        }

        const keptStartIndex = Math.max(0, Math.min(messages.length, compaction.keptStartIndex));
        if (keptStartIndex <= 0 || keptStartIndex >= messages.length) {
          return messages;
        }

        return [
          createSyntheticSummaryMessage({
            summaryText: compaction.summaryText,
            resolvedModel: args.resolvedModel,
            timestamp: messages[keptStartIndex - 1]?.timestamp ?? Date.now(),
          }),
          ...messages.slice(keptStartIndex),
        ];
      } catch (error) {
        if (postToolCompactionTimeout.timedOut()) {
          return messages;
        }
        shouldResumePostToolStallAbort = false;
        throw error;
      } finally {
        postToolCompactionTimeout.clear();
        if (shouldResumePostToolStallAbort && !finalRoomDeliveryShortCircuitArmed) {
          postToolStallAbort.resume();
        }
      }
    },
  });

  const startingMessageCount = agent.state.messages.length;
  const toolEvents: ToolExecution[] = [];
  let assistantText = "";
  let toolTurnCount = 0;
  let toolLoopErrorMessage = "";
  const lastRoomMessagePreviewByToolCallId = new Map<string, string>();
  const lastToolCallProgressById = new Map<string, string>();
  const currentRoomId = args.resolvedOptions.toolContext?.currentRoomId?.trim();
  let finalRoomDeliveryShortCircuitTimer: ReturnType<typeof setTimeout> | null = null;
  let finalRoomDeliveryShortCircuitArmed = false;
  let shortCircuitedAfterFinalRoomDelivery = false;
  let resolveFinalRoomDeliveryShortCircuit: (() => void) | null = null;
  const finalRoomDeliveryShortCircuitPromise = new Promise<void>((resolve) => {
    resolveFinalRoomDeliveryShortCircuit = resolve;
  });

  const clearFinalRoomDeliveryShortCircuit = () => {
    if (finalRoomDeliveryShortCircuitTimer !== null) {
      clearTimeout(finalRoomDeliveryShortCircuitTimer);
      finalRoomDeliveryShortCircuitTimer = null;
    }
    finalRoomDeliveryShortCircuitArmed = false;
  };

  const armFinalRoomDeliveryShortCircuit = () => {
    clearFinalRoomDeliveryShortCircuit();
    finalRoomDeliveryShortCircuitArmed = true;
    finalRoomDeliveryShortCircuitTimer = setTimeout(() => {
      shortCircuitedAfterFinalRoomDelivery = true;
      agent.abort();
      resolveFinalRoomDeliveryShortCircuit?.();
    }, FINAL_ROOM_DELIVERY_SHORT_CIRCUIT_MS);
  };

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      clearFinalRoomDeliveryShortCircuit();
      postToolStallAbort.clear();
      toolCallStallAbort.clear();
      assistantText += event.assistantMessageEvent.delta;
      args.callbacks?.onTextDelta?.(event.assistantMessageEvent.delta);
      return;
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta") {
      clearFinalRoomDeliveryShortCircuit();
      postToolStallAbort.clear();
      const contentBlock = event.assistantMessageEvent.partial.content[event.assistantMessageEvent.contentIndex];
      if (contentBlock?.type !== "toolCall") {
        return;
      }

      const previewSource = contentBlock as typeof contentBlock & { partialJson?: unknown };
      const preview = extractRoomMessagePreviewFromToolCallBlock({
        id: contentBlock.id,
        name: contentBlock.name,
        arguments: contentBlock.arguments,
        ...(typeof previewSource.partialJson === "string"
          ? { partialJson: previewSource.partialJson }
          : {}),
      });
      const progressSignature = preview
        ? JSON.stringify(preview)
        : getToolCallProgressSignature({
            name: contentBlock.name,
            arguments: contentBlock.arguments,
            ...(typeof previewSource.partialJson === "string"
              ? { partialJson: previewSource.partialJson }
              : {}),
          });
      if (lastToolCallProgressById.get(contentBlock.id) !== progressSignature) {
        lastToolCallProgressById.set(contentBlock.id, progressSignature);
        toolCallStallAbort.arm(contentBlock.name);
      }
      if (!preview) {
        return;
      }

      const previewSignature = JSON.stringify(preview);
      if (lastRoomMessagePreviewByToolCallId.get(preview.toolCallId) === previewSignature) {
        return;
      }

      lastRoomMessagePreviewByToolCallId.set(preview.toolCallId, previewSignature);
      args.callbacks?.onRoomMessagePreview?.(preview);
      return;
    }

    if (event.type === "tool_execution_end") {
      toolCallStallAbort.clear();
      const toolEvent = extractToolExecution(event);
      if (!toolEvent) {
        return;
      }

      lastToolCallProgressById.delete(toolEvent.id);
      const numberedToolEvent = {
        ...toolEvent,
        sequence: toolEvents.length + 1,
      } satisfies ToolExecution;
      toolEvents.push(numberedToolEvent);
      args.callbacks?.onTool?.(numberedToolEvent);
      if (shouldShortCircuitAfterFinalRoomDelivery(numberedToolEvent, currentRoomId)) {
        armFinalRoomDeliveryShortCircuit();
      } else {
        clearFinalRoomDeliveryShortCircuit();
      }
      postToolStallAbort.arm(numberedToolEvent);
      return;
    }

    if (event.type === "turn_end" && isAssistantMessage(event.message)) {
      const hasToolCalls = event.message.content.some((item) => item.type === "toolCall");
      if (event.toolResults.length > 0 && !finalRoomDeliveryShortCircuitArmed) {
        pendingPostToolBatchCompaction = true;
      }
      if (!hasToolCalls) {
        clearFinalRoomDeliveryShortCircuit();
        postToolStallAbort.clear();
        toolCallStallAbort.clear();
        return;
      }

      toolTurnCount += 1;
      if (toolTurnCount >= args.resolvedOptions.maxToolLoopSteps) {
        toolLoopErrorMessage = `Tool loop exceeded the maximum number of steps (${args.resolvedOptions.maxToolLoopSteps}).`;
        agent.abort();
      }
    }
  });

  const abortListener = () => agent.abort();
  args.resolvedOptions.signal?.addEventListener("abort", abortListener, { once: true });

  const continuePromise = agent.continue()
    .then(() => ({ kind: "completed" } as const))
    .catch((error) => ({ kind: "error", error } as const));

  try {
    const continueOutcome = await Promise.race([
      continuePromise,
      finalRoomDeliveryShortCircuitPromise.then(() => ({ kind: "short_circuited" } as const)),
    ]);
    if (continueOutcome.kind === "error") {
      if (toolCallStallAbort.getMessage()) {
        throw new Error(toolCallStallAbort.getMessage());
      }
      throw (postToolStallAbort.getMessage() ? new Error(postToolStallAbort.getMessage()) : continueOutcome.error);
    }
  } finally {
    clearFinalRoomDeliveryShortCircuit();
    postToolStallAbort.clear();
    toolCallStallAbort.clear();
    unsubscribe();
    args.resolvedOptions.signal?.removeEventListener("abort", abortListener);
  }

  throwIfAborted(args.resolvedOptions.signal);

  const generatedMessages = agent.state.messages.slice(startingMessageCount) as Message[];
  const generatedAssistantMessages = getGeneratedAssistantMessages(generatedMessages);
  const finalAssistantMessage = generatedAssistantMessages[generatedAssistantMessages.length - 1];

  if (toolLoopErrorMessage) {
    throw new Error(toolLoopErrorMessage);
  }

  if (toolCallStallAbort.getMessage()) {
    throw new Error(toolCallStallAbort.getMessage());
  }

  if (postToolStallAbort.getMessage()) {
    throw new Error(postToolStallAbort.getMessage());
  }

  if (finalAssistantMessage?.stopReason === "error" || (finalAssistantMessage?.stopReason === "aborted" && !shortCircuitedAfterFinalRoomDelivery)) {
    throw new Error(finalAssistantMessage.errorMessage || "The model request failed.");
  }

  const derivedAssistantText = assistantText.trim()
    || generatedAssistantMessages
      .map((message) => extractAssistantText(message))
      .filter(Boolean)
      .join("\n\n")
      .trim();

  return {
    assistantText: shortCircuitedAfterFinalRoomDelivery ? derivedAssistantText : (derivedAssistantText || "The model returned no text."),
    toolEvents,
    resolvedModel: args.resolvedModel.resolvedModelRef,
    compatibility: args.resolvedModel.compatibility,
    actualApiFormat: args.resolvedModel.actualApiFormat,
    ...(finalAssistantMessage?.responseId ? { responseId: finalAssistantMessage.responseId } : {}),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    continuation: {
      strategy: responsesContinuation ? "previous_response_id" : "replay",
      ...(responsesContinuation?.previousResponseId ? { previousResponseId: responsesContinuation.previousResponseId } : {}),
    },
    ...(toAssistantUsageSnapshot(finalAssistantMessage?.usage) ? { usage: toAssistantUsageSnapshot(finalAssistantMessage?.usage) } : {}),
    ...(snapshotHistoryDelta(generatedMessages) ? { historyDelta: snapshotHistoryDelta(generatedMessages) } : {}),
  };
}

async function executeConversation(
  messages: VisibleMessage[],
  settings: ChatSettings,
  callbacks?: StreamConversationCallbacks,
  options?: ConversationOptions,
): Promise<RunConversationResult> {
  throwIfAborted(options?.signal);
  ensureGlobalProxyDispatcherInstalled();

  const resolvedOptions = resolveConversationOptions({
    ...options,
    maxToolLoopSteps: options?.maxToolLoopSteps ?? settings.maxToolLoopSteps,
  });
  const effectiveSettings = await runBeforeModelResolveHooks({
    agentId: resolvedOptions.toolContext?.currentAgentId,
    settings,
    toolScope: resolvedOptions.toolScope,
    toolContext: resolvedOptions.toolContext,
  });
  const resolvedModel = resolvePiModel(effectiveSettings, resolvedOptions.modelConfigOverrides);
  const baseSystemPrompt = resolvedOptions.systemPromptOverride || buildSystemPrompt(effectiveSettings.systemPrompt);
  const systemPromptText = await runBeforePromptBuildHooks({
    agentId: resolvedOptions.toolContext?.currentAgentId,
    settings: effectiveSettings,
    toolScope: resolvedOptions.toolScope,
    toolContext: resolvedOptions.toolContext,
    systemPrompt: baseSystemPrompt,
  });
  const sessionId = buildStableSessionId({
    resolvedModel,
    toolContext: resolvedOptions.toolContext,
  });
  const continuationOrder = resolvedModel.actualApiFormat === "responses"
    ? getResponsesContinuationOrder(resolvedModel.compatibility)
    : (["replay"] as ResponsesContinuationStrategy[]);
  let lastError: unknown = undefined;

  for (const continuationStrategy of continuationOrder) {
    try {
      return await runConversationAttempt({
        messages,
        resolvedModel,
        systemPromptText,
        callbacks,
        resolvedOptions,
        continuationStrategy,
        sessionId,
      });
    } catch (error) {
      if (continuationStrategy === "previous_response_id" && shouldFallbackToResponsesReplay(error)) {
        lastError = error;
        continue;
      }

      throw createConversationError(
        normalizeConversationFailure(error, error instanceof Error ? error.message : "The model request failed."),
        resolvedModel.actualApiFormat,
        resolvedModel.compatibility,
      );
    }
  }

  throw createConversationError(
    normalizeConversationFailure(lastError, lastError instanceof Error ? lastError.message : "The model request failed."),
    resolvedModel.actualApiFormat,
    resolvedModel.compatibility,
  );
}

export function extractAssistantMetaFromConversationError(error: unknown): AssistantMessageMeta | undefined {
  return error instanceof ConversationExecutionError ? error.assistantMeta : undefined;
}

export async function runConversation(
  messages: VisibleMessage[],
  settings: ChatSettings,
  options?: ConversationOptions,
): Promise<RunConversationResult> {
  return executeConversation(messages, settings, undefined, options);
}

export async function streamConversation(
  messages: VisibleMessage[],
  settings: ChatSettings,
  callbacks?: StreamConversationCallbacks,
  options?: ConversationOptions,
): Promise<RunConversationResult> {
  return executeConversation(messages, settings, callbacks, options);
}

export async function runTextPrompt(args: {
  prompt: string;
  settings: ChatSettings;
  systemPrompt?: string;
  signal?: AbortSignal;
  modelConfigOverrides?: ModelConfigExecutionOverrides;
}): Promise<RunTextPromptResult> {
  throwIfAborted(args.signal);
  ensureGlobalProxyDispatcherInstalled();

  const effectiveSettings = await runBeforeModelResolveHooks({
    settings: args.settings,
    toolScope: "default",
  });
  const resolvedModel = resolvePiModel(effectiveSettings, args.modelConfigOverrides);
  const sessionId = buildStableSessionId({
    resolvedModel,
  });
  const agent = new Agent({
    initialState: {
      systemPrompt: args.systemPrompt?.trim() || "",
      model: resolvedModel.model,
      thinkingLevel: toPiAgentThinkingLevel(resolvedModel.actualThinkingLevel),
      tools: [],
      messages: [
        {
          role: "user",
          content: args.prompt,
          timestamp: Date.now(),
        },
      ],
    },
    getApiKey: resolvedModel.apiKey
      ? async () => resolvedModel.apiKey
      : undefined,
    sessionId,
  });

  const abortListener = () => agent.abort();
  args.signal?.addEventListener("abort", abortListener, { once: true });

  try {
    await agent.continue();
  } catch (error) {
    throw createConversationError(
      normalizeConversationFailure(error, error instanceof Error ? error.message : "The model request failed."),
      resolvedModel.actualApiFormat,
      resolvedModel.compatibility,
    );
  } finally {
    args.signal?.removeEventListener("abort", abortListener);
  }

  throwIfAborted(args.signal);

  const generatedAssistantMessages = getGeneratedAssistantMessages(agent.state.messages as Message[]);
  const finalAssistantMessage = generatedAssistantMessages[generatedAssistantMessages.length - 1];

  if (finalAssistantMessage?.stopReason === "error" || finalAssistantMessage?.stopReason === "aborted") {
    throw createConversationError(
      normalizeConversationFailure(finalAssistantMessage.errorMessage, finalAssistantMessage.errorMessage || "The model request failed."),
      resolvedModel.actualApiFormat,
      resolvedModel.compatibility,
    );
  }

  const assistantText = generatedAssistantMessages
    .map((message) => extractAssistantText(message))
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return {
    assistantText: assistantText || "The model returned no text.",
    resolvedModel: resolvedModel.resolvedModelRef,
    compatibility: resolvedModel.compatibility,
    actualApiFormat: resolvedModel.actualApiFormat,
    ...(finalAssistantMessage?.responseId ? { responseId: finalAssistantMessage.responseId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(toAssistantUsageSnapshot(finalAssistantMessage?.usage) ? { usage: toAssistantUsageSnapshot(finalAssistantMessage?.usage) } : {}),
  };
}
