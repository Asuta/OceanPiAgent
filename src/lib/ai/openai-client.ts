import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Message, Model } from "@mariozechner/pi-ai";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { resolvePiModel } from "@/lib/ai/pi-model-resolver";
import { getPiAgentTools, type PiToolResultDetails } from "@/lib/ai/pi-agent-tools";
import { runBeforeModelResolveHooks, runBeforePromptBuildHooks } from "@/lib/ai/runtime-hooks";
import { ensureGlobalProxyDispatcherInstalled } from "@/lib/server/proxy-fetch";
import type {
  ApiFormat,
  AssistantMessageMeta,
  ChatMessage,
  ChatSettings,
  EmptyCompletionDiagnostic,
  ProviderCompatibility,
  RecoveryDiagnostic,
  RoomToolContext,
  ToolExecution,
  ToolScope,
} from "@/lib/chat/types";
import { coerceMaxToolLoopSteps } from "@/lib/chat/types";

type VisibleMessage = Pick<ChatMessage, "role" | "content">;

interface RunConversationResult {
  assistantText: string;
  toolEvents: ToolExecution[];
  resolvedModel: string;
  compatibility: ProviderCompatibility;
  actualApiFormat: ApiFormat;
  emptyCompletion?: EmptyCompletionDiagnostic;
  recovery?: RecoveryDiagnostic;
}

interface RunTextPromptResult {
  assistantText: string;
  resolvedModel: string;
  compatibility: ProviderCompatibility;
  actualApiFormat: ApiFormat;
}

interface StreamConversationCallbacks {
  onTextDelta?: (delta: string) => void;
  onTool?: (tool: ToolExecution) => void;
}

interface ConversationOptions {
  toolScope?: ToolScope;
  systemPromptOverride?: string;
  maxToolLoopSteps?: number;
  signal?: AbortSignal;
  toolContext?: RoomToolContext;
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
} {
  return {
    toolScope: options?.toolScope || "default",
    systemPromptOverride: options?.systemPromptOverride || "",
    maxToolLoopSteps: coerceMaxToolLoopSteps(options?.maxToolLoopSteps),
    signal: options?.signal,
    toolContext: options?.toolContext,
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
    usage: createUsage(),
    stopReason: "stop",
    timestamp,
  };
}

function createConversationHistory(messages: VisibleMessage[], model: Model<Api>): Message[] {
  const startTimestamp = Date.now() - Math.max(messages.length, 1) * 1_000;
  return messages.map((message, index) => {
    const timestamp = startTimestamp + index * 1_000;
    if (message.role === "user") {
      return {
        role: "user",
        content: message.content,
        timestamp,
      } satisfies Message;
    }

    return createHistoricalAssistantMessage(message, model, timestamp);
  });
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
  const resolvedModel = resolvePiModel(effectiveSettings);
  const baseSystemPrompt = resolvedOptions.systemPromptOverride || buildSystemPrompt(effectiveSettings.systemPrompt);
  const systemPromptText = await runBeforePromptBuildHooks({
    agentId: resolvedOptions.toolContext?.currentAgentId,
    settings: effectiveSettings,
    toolScope: resolvedOptions.toolScope,
    toolContext: resolvedOptions.toolContext,
    systemPrompt: baseSystemPrompt,
  });
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPromptText,
      model: resolvedModel.model,
      thinkingLevel: resolvedModel.actualThinkingLevel,
      tools: getPiAgentTools(resolvedOptions.toolScope, resolvedOptions.toolContext),
      messages: createConversationHistory(messages, resolvedModel.model),
    },
    getApiKey: resolvedModel.apiKey
      ? async () => resolvedModel.apiKey
      : undefined,
  });

  const startingMessageCount = agent.state.messages.length;
  const toolEvents: ToolExecution[] = [];
  let assistantText = "";
  let toolTurnCount = 0;
  let toolLoopErrorMessage = "";

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      assistantText += event.assistantMessageEvent.delta;
      callbacks?.onTextDelta?.(event.assistantMessageEvent.delta);
      return;
    }

    if (event.type === "tool_execution_end") {
      const toolEvent = extractToolExecution(event);
      if (!toolEvent) {
        return;
      }

      const numberedToolEvent = {
        ...toolEvent,
        sequence: toolEvents.length + 1,
      } satisfies ToolExecution;
      toolEvents.push(numberedToolEvent);
      callbacks?.onTool?.(numberedToolEvent);
      return;
    }

    if (event.type === "turn_end" && isAssistantMessage(event.message)) {
      const hasToolCalls = event.message.content.some((item) => item.type === "toolCall");
      if (!hasToolCalls) {
        return;
      }

      toolTurnCount += 1;
      if (toolTurnCount >= resolvedOptions.maxToolLoopSteps) {
        toolLoopErrorMessage = `Tool loop exceeded the maximum number of steps (${resolvedOptions.maxToolLoopSteps}).`;
        agent.abort();
      }
    }
  });

  const abortListener = () => agent.abort();
  resolvedOptions.signal?.addEventListener("abort", abortListener, { once: true });

  try {
    await agent.continue();
  } catch (error) {
    throw createConversationError(
      normalizeConversationFailure(error, error instanceof Error ? error.message : "The model request failed."),
      resolvedModel.actualApiFormat,
      resolvedModel.compatibility,
    );
  } finally {
    unsubscribe();
    resolvedOptions.signal?.removeEventListener("abort", abortListener);
  }

  throwIfAborted(resolvedOptions.signal);

  const generatedMessages = agent.state.messages.slice(startingMessageCount) as Message[];
  const generatedAssistantMessages = getGeneratedAssistantMessages(generatedMessages);
  const finalAssistantMessage = generatedAssistantMessages[generatedAssistantMessages.length - 1];

  if (toolLoopErrorMessage) {
    throw createConversationError(
      toolLoopErrorMessage,
      resolvedModel.actualApiFormat,
      resolvedModel.compatibility,
    );
  }

  if (finalAssistantMessage?.stopReason === "error" || finalAssistantMessage?.stopReason === "aborted") {
    throw createConversationError(
      normalizeConversationFailure(finalAssistantMessage.errorMessage, finalAssistantMessage.errorMessage || "The model request failed."),
      resolvedModel.actualApiFormat,
      resolvedModel.compatibility,
    );
  }

  const derivedAssistantText = assistantText.trim()
    || generatedAssistantMessages
      .map((message) => extractAssistantText(message))
      .filter(Boolean)
      .join("\n\n")
      .trim();

  return {
    assistantText: derivedAssistantText || "The model returned no text.",
    toolEvents,
    resolvedModel: resolvedModel.resolvedModelRef,
    compatibility: resolvedModel.compatibility,
    actualApiFormat: resolvedModel.actualApiFormat,
  };
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
}): Promise<RunTextPromptResult> {
  throwIfAborted(args.signal);
  ensureGlobalProxyDispatcherInstalled();

  const effectiveSettings = await runBeforeModelResolveHooks({
    settings: args.settings,
    toolScope: "default",
  });
  const resolvedModel = resolvePiModel(effectiveSettings);
  const agent = new Agent({
    initialState: {
      systemPrompt: args.systemPrompt?.trim() || "",
      model: resolvedModel.model,
      thinkingLevel: resolvedModel.actualThinkingLevel,
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
  };
}
