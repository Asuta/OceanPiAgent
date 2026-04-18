export type ChatRole = "user" | "assistant";

export type ApiFormat = "chat_completions" | "responses";

export const THINKING_LEVELS = ["off", "none", "low", "medium", "high", "xhigh"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ProviderKey = "openai" | "right_codes" | "generic";

export type ProviderMode = "auto" | ProviderKey;

export const MODEL_CONFIG_KINDS = ["openai_compatible", "pi_builtin"] as const;

export type ModelConfigKind = (typeof MODEL_CONFIG_KINDS)[number];

export type ToolScope = "default" | "room";
export const MEMORY_BACKENDS = ["sqlite-fts", "markdown"] as const;
export type MemoryBackendId = (typeof MEMORY_BACKENDS)[number];
export const COMPACTION_PREFERENCES = ["llm_preferred", "procedural_preferred"] as const;
export type CompactionPreference = (typeof COMPACTION_PREFERENCES)[number];

export const DEFAULT_MAX_TOOL_LOOP_STEPS = 200;
export const DEFAULT_COMPACTION_TOKEN_THRESHOLD = 200_000;
export const DEFAULT_COMPACTION_PREFERENCE: CompactionPreference = "llm_preferred";
export const MIN_COMPACTION_TOKEN_THRESHOLD = 1_000;
export const MAX_COMPACTION_TOKEN_THRESHOLD = 2_000_000;

export const MIN_MAX_TOOL_LOOP_STEPS = 1;

export const MAX_MAX_TOOL_LOOP_STEPS = 200;

export type ChatCompletionsToolStyle = "tools" | "functions";

export type ResponsesContinuation = "previous_response_id" | "replay";

export type ResponsesPayloadMode = "json" | "sse" | "auto";

export type ToolExecutionStatus = "success" | "error";

export interface ToolExecutionDetails {
  exitCode?: number | null;
  truncated?: boolean;
  fullOutputPath?: string;
  cwd?: string;
  shell?: string;
  timedOut?: boolean;
  aborted?: boolean;
}

export type RoomAgentId = string;

export type RoomMembershipRole = "owner" | "member";

export interface ProviderCompatibility {
  providerKey: ProviderKey;
  providerLabel: string;
  baseUrl: string;
  chatCompletionsToolStyle: ChatCompletionsToolStyle;
  responsesContinuation: ResponsesContinuation;
  responsesPayloadMode: ResponsesPayloadMode;
  notes: string[];
}

export interface ModelConfig {
  id: string;
  name: string;
  kind: ModelConfigKind;
  model: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  providerMode: ProviderMode;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfigExecutionOverrides {
  baseUrl?: string;
  apiKey?: string;
}

export type RoomMessageRole = "user" | "assistant" | "system";

export type RoomMessageSource = "user" | "agent_emit" | "system";

export type RoomMessageKind =
  | "user_input"
  | "answer"
  | "progress"
  | "warning"
  | "error"
  | "clarification"
  | "system";

export type RoomMessageStatus = "pending" | "streaming" | "completed" | "failed";

export type RoomMessageReceiptStatus = "none" | "read_no_reply";

export interface RoomMessageReceipt {
  participantId: string;
  participantName: string;
  agentId?: RoomAgentId;
  type: "read_no_reply";
  createdAt: string;
}

export interface MessageImageAttachment {
  id: string;
  kind: "image";
  mimeType: string;
  filename: string;
  sizeBytes: number;
  storagePath: string;
  url: string;
}

export type RoomSenderRole = "participant" | "system";

export type RoomParticipantRuntimeKind = "human" | "agent";

export interface RoomSender {
  id: string;
  name: string;
  role: RoomSenderRole;
}

export interface RoomParticipant {
  id: string;
  name: string;
  senderRole: RoomSenderRole;
  runtimeKind: RoomParticipantRuntimeKind;
  enabled: boolean;
  order: number;
  agentId?: RoomAgentId;
  createdAt: string;
  updatedAt: string;
}

export interface AgentInfoCard {
  agentId: RoomAgentId;
  label: string;
  summary: string;
  skills: string[];
  workingStyle: string;
}

export interface RoomParticipantSnapshot {
  participantId: string;
  name: string;
  runtimeKind: RoomParticipantRuntimeKind;
  membershipRole: RoomMembershipRole;
  enabled: boolean;
  agentId?: RoomAgentId;
}

export interface AttachedRoomDefinition {
  id: string;
  title: string;
  archived: boolean;
  ownerParticipantId: string | null;
  ownerName: string | null;
  currentAgentMembershipRole: RoomMembershipRole | null;
  currentAgentIsOwner: boolean;
  participants: RoomParticipantSnapshot[];
  messageCount: number;
  latestMessageAt: string | null;
}

export interface RoomHistoryMessageSummary {
  messageId: string;
  messageKey?: string;
  seq: number;
  senderId: string;
  senderName: string;
  senderRole: RoomSenderRole;
  role: RoomMessageRole;
  source: RoomMessageSource;
  kind: RoomMessageKind;
  status: RoomMessageStatus;
  final: boolean;
  createdAt: string;
  content: string;
  attachments: MessageImageAttachment[];
  receipts: RoomMessageReceipt[];
}

export interface RoomToolContext {
  currentAgentId?: RoomAgentId;
  currentRoomId?: string;
  currentSettings?: ChatSettings;
  attachedRooms: AttachedRoomDefinition[];
  knownAgents: AgentInfoCard[];
  roomHistoryById: Record<string, RoomHistoryMessageSummary[]>;
}

export interface RoomSchedulerState {
  status: "idle" | "running";
  nextAgentParticipantId: string | null;
  activeParticipantId: string | null;
  roundCount: number;
  agentCursorByParticipantId: Record<string, number>;
  agentReceiptRevisionByParticipantId: Record<string, number>;
}

export type AgentVisibleRoomMessageKind = Exclude<RoomMessageKind, "user_input" | "system">;

export interface RoomToolAction {
  type: "read_no_reply";
  roomId: string;
  messageId: string;
}

export interface CreateRoomToolAction {
  type: "create_room";
  roomId: string;
  title: string;
  agentIds: RoomAgentId[];
}

export interface AddAgentsToRoomToolAction {
  type: "add_agents_to_room";
  roomId: string;
  agentIds: RoomAgentId[];
}

export interface LeaveRoomToolAction {
  type: "leave_room";
  roomId: string;
}

export interface RemoveRoomParticipantToolAction {
  type: "remove_room_participant";
  roomId: string;
  participantId: string;
}

export type RoomManagementToolAction =
  | CreateRoomToolAction
  | AddAgentsToRoomToolAction
  | LeaveRoomToolAction
  | RemoveRoomParticipantToolAction;

export type RoomToolActionUnion = RoomToolAction | RoomManagementToolAction;

export interface BeginRoomMessageStreamAction {
  type: "begin_room_message_stream";
  roomId: string;
  messageKey: string;
  kind: AgentVisibleRoomMessageKind;
  initialContent: string;
}

export interface FinalizeRoomMessageStreamAction {
  type: "finalize_room_message_stream";
  roomId: string;
  messageKey: string;
  kind: AgentVisibleRoomMessageKind;
  status: Extract<RoomMessageStatus, "completed" | "failed">;
  final: boolean;
}

export type RoomMessageStreamAction = BeginRoomMessageStreamAction | FinalizeRoomMessageStreamAction;

export interface RoomMessageEmission {
  roomId: string;
  messageKey?: string;
  content: string;
  kind: AgentVisibleRoomMessageKind;
  status: RoomMessageStatus;
  final: boolean;
}

export interface RoomMessagePreviewEmission extends RoomMessageEmission {
  toolCallId: string;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  seq: number;
  role: RoomMessageRole;
  sender: RoomSender;
  content: string;
  attachments: MessageImageAttachment[];
  source: RoomMessageSource;
  kind: RoomMessageKind;
  status: RoomMessageStatus;
  final: boolean;
  createdAt: string;
  receipts: RoomMessageReceipt[];
  receiptStatus: RoomMessageReceiptStatus;
  receiptUpdatedAt: string | null;
}

export interface RoomMessageReceiptUpdate {
  roomId: string;
  messageId: string;
  receipt: RoomMessageReceipt;
  receiptStatus: RoomMessageReceiptStatus;
  receiptUpdatedAt: string | null;
}

export interface RoomAgentSnapshot {
  id: RoomAgentId;
  label: string;
}

export interface RoomAgentDefinition extends RoomAgentSnapshot {
  summary: string;
  skills: string[];
  workingStyle: string;
  instruction: string;
}

export interface AgentSharedState {
  settings: ChatSettings;
  agentTurns: AgentRoomTurn[];
  resolvedModel: string;
  compatibility: ProviderCompatibility | null;
  updatedAt: string;
}

export interface ToolExecution {
  id: string;
  sequence: number;
  toolName: string;
  displayName: string;
  inputSummary: string;
  inputText: string;
  resultPreview: string;
  outputText: string;
  status: ToolExecutionStatus;
  durationMs: number;
  details?: ToolExecutionDetails;
  roomMessage?: RoomMessageEmission;
  roomMessageStream?: RoomMessageStreamAction;
  roomAction?: RoomToolActionUnion;
}

export interface DraftTextSegment {
  id: string;
  sequence: number;
  content: string;
  status: "streaming" | "completed";
}

export type TurnTimelineEvent =
  | {
      id: string;
      sequence: number;
      type: "tool";
      toolId: string;
    }
  | {
      id: string;
      sequence: number;
      type: "room-message";
      messageId: string;
      roomId: string;
    }
  | {
      id: string;
      sequence: number;
      type: "draft-segment";
      segmentId: string;
    };

export interface EmptyCompletionDiagnostic {
  createdAt: string;
  apiFormat: ApiFormat;
  providerKey: ProviderKey;
  providerLabel: string;
  requestedModel: string;
  resolvedModel: string;
  baseUrl: string;
  textDeltaLength: number;
  finalTextLength: number;
  toolCallCount: number;
  toolEventCount: number;
  payloadMode?: ResponsesPayloadMode;
  finishReason?: string | null;
  responseId?: string;
  assistantContentShape?: string;
  outputItemTypes?: string[];
  chunkCount?: number;
  sawDoneEvent?: boolean;
  chunkPreviews?: string[];
}

export interface RecoveryAttemptDiagnostic {
  attempt: number;
  strategy: "retry_no_output" | "resume_after_tools";
  trigger: "finish_reason_error";
  delayMs: number;
  toolEventCount: number;
  finishReason?: string | null;
  chunkCount?: number;
  sawDoneEvent?: boolean;
  chunkPreviews?: string[];
}

export interface RecoveryDiagnostic {
  attempts: RecoveryAttemptDiagnostic[];
}

export interface AssistantUsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface AssistantContinuationSnapshot {
  strategy: ResponsesContinuation;
  previousResponseId?: string;
}

export interface AssistantHistoryTextPart {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface AssistantHistoryThinkingPart {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface AssistantHistoryImagePart {
  type: "image";
  data: string;
  mimeType: string;
}

export interface AssistantHistoryToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  partialJson?: string;
  thoughtSignature?: string;
}

export interface AssistantHistoryUsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface AssistantHistoryUserMessage {
  role: "user";
  content: string | Array<AssistantHistoryTextPart | AssistantHistoryImagePart>;
  timestamp: number;
}

export interface AssistantHistoryAssistantMessage {
  role: "assistant";
  content: Array<AssistantHistoryTextPart | AssistantHistoryThinkingPart | AssistantHistoryToolCallPart>;
  api: string;
  provider: string;
  model: string;
  responseId?: string;
  usage: AssistantHistoryUsageSnapshot;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

export interface AssistantHistoryToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<AssistantHistoryTextPart | AssistantHistoryImagePart>;
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type AssistantHistoryMessage =
  | AssistantHistoryUserMessage
  | AssistantHistoryAssistantMessage
  | AssistantHistoryToolResultMessage;

export interface AssistantMessageMeta {
  apiFormat: ApiFormat;
  compatibility: ProviderCompatibility;
  responseId?: string;
  sessionId?: string;
  continuation?: AssistantContinuationSnapshot;
  usage?: AssistantUsageSnapshot;
  historyDelta?: AssistantHistoryMessage[];
  emptyCompletion?: EmptyCompletionDiagnostic;
  recovery?: RecoveryDiagnostic;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  attachments: MessageImageAttachment[];
  tools?: ToolExecution[];
  meta?: AssistantMessageMeta;
}

export interface ChatSettings {
  modelConfigId: string | null;
  apiFormat: ApiFormat;
  model: string;
  systemPrompt: string;
  providerMode: ProviderMode;
  memoryBackend: MemoryBackendId;
  compactionTokenThreshold: number;
  compactionPreference: CompactionPreference;
  maxToolLoopSteps: number;
  thinkingLevel: ThinkingLevel;
  enabledSkillIds: string[];
}

export interface ChatRequestBody {
  messages: ChatMessage[];
  settings: ChatSettings;
  stream?: boolean;
}

export type AgentTurnStatus = "running" | "continued" | "completed" | "error";

export interface AgentRoomTurn {
  id: string;
  agent: RoomAgentSnapshot;
  userMessage: RoomMessage;
  anchorMessageId?: string;
  continuationSnapshot?: string;
  assistantContent: string;
  draftSegments?: DraftTextSegment[];
  timeline?: TurnTimelineEvent[];
  tools: ToolExecution[];
  emittedMessages: RoomMessage[];
  status: AgentTurnStatus;
  meta?: AssistantMessageMeta;
  resolvedModel?: string;
  error?: string;
}

export interface RoomSession {
  id: string;
  title: string;
  agentId: RoomAgentId;
  archivedAt: string | null;
  pinnedAt: string | null;
  ownerParticipantId: string | null;
  receiptRevision: number;
  participants: RoomParticipant[];
  scheduler: RoomSchedulerState;
  roomMessages: RoomMessage[];
  agentTurns: AgentRoomTurn[];
  error: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoomWorkspaceState {
  rooms: RoomSession[];
  agentStates: Record<RoomAgentId, AgentSharedState>;
  activeRoomId: string;
  selectedConsoleAgentId?: RoomAgentId;
}

export type CronDeliveryPolicy = "silent" | "only_on_result" | "always_post_summary";

export type RoomCronSchedule =
  | {
      type: "once";
      at: string;
    }
  | {
      type: "daily";
      time: string;
    }
  | {
      type: "weekly";
      dayOfWeek: number;
      time: string;
    };

export type RoomCronJobStatus = "idle" | "queued" | "running" | "error";

export interface RoomCronJob {
  id: string;
  agentId: RoomAgentId;
  targetRoomId: string;
  title: string;
  prompt: string;
  schedule: RoomCronSchedule;
  deliveryPolicy: CronDeliveryPolicy;
  enabled: boolean;
  status: RoomCronJobStatus;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RoomCronRunStatus = "running" | "completed" | "failed";

export interface RoomCronRunRecord {
  id: string;
  jobId: string;
  agentId: RoomAgentId;
  targetRoomId: string;
  scheduledFor: string;
  startedAt: string;
  finishedAt: string | null;
  status: RoomCronRunStatus;
  summary: string;
  error: string | null;
}

export interface RoomChatResponseBody {
  turn: AgentRoomTurn;
  resolvedModel: string;
  compatibility: ProviderCompatibility;
  emittedMessages: RoomMessage[];
  receiptUpdates: RoomMessageReceiptUpdate[];
}

export interface ChatResponseBody {
  message: ChatMessage;
  resolvedModel: string;
  compatibility: ProviderCompatibility;
}

export type ChatStreamEvent =
  | {
      type: "text-delta";
      delta: string;
    }
  | {
      type: "tool";
      tool: ToolExecution;
    }
  | {
      type: "done";
      message: ChatMessage;
      resolvedModel: string;
      compatibility: ProviderCompatibility;
    }
  | {
      type: "error";
      error: string;
      meta?: AssistantMessageMeta;
    };

export type RoomChatStreamEvent =
  | {
      type: "turn-start";
      turn: AgentRoomTurn;
    }
  | {
      type: "agent-text-delta";
      delta: string;
    }
  | {
      type: "tool";
      tool: ToolExecution;
    }
  | {
      type: "room-message-preview";
      message: RoomMessage;
    }
  | {
      type: "room-message";
      message: RoomMessage;
    }
  | {
      type: "message-receipt";
      update: RoomMessageReceiptUpdate;
    }
  | {
      type: "done";
      turn: AgentRoomTurn;
      resolvedModel: string;
      compatibility: ProviderCompatibility;
    }
  | {
      type: "error";
      error: string;
      meta?: AssistantMessageMeta;
    };

export function coerceMaxToolLoopSteps(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_TOOL_LOOP_STEPS;
  }

  const rounded = Math.round(value);
  return Math.min(MAX_MAX_TOOL_LOOP_STEPS, Math.max(MIN_MAX_TOOL_LOOP_STEPS, rounded));
}

export function coerceCompactionTokenThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_COMPACTION_TOKEN_THRESHOLD;
  }

  const rounded = Math.round(value);
  return Math.min(MAX_COMPACTION_TOKEN_THRESHOLD, Math.max(MIN_COMPACTION_TOKEN_THRESHOLD, rounded));
}

export function coerceCompactionPreference(value: unknown): CompactionPreference {
  return typeof value === "string" && COMPACTION_PREFERENCES.includes(value as CompactionPreference)
    ? (value as CompactionPreference)
    : DEFAULT_COMPACTION_PREFERENCE;
}

export function coerceThinkingLevel(value: unknown): ThinkingLevel {
  if (value === "minimal") {
    return "none";
  }

  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel)
    ? (value as ThinkingLevel)
    : "off";
}

export function coerceSkillIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 24);
}
