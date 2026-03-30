import { z } from "zod";
import {
  MEMORY_BACKENDS,
  MAX_MAX_TOOL_LOOP_STEPS,
  MIN_MAX_TOOL_LOOP_STEPS,
  THINKING_LEVELS,
  type RoomWorkspaceState,
} from "@/lib/chat/types";

export const roomAgentIdSchema = z.string().trim().min(1).max(120);
const providerKeySchema = z.enum(["openai", "right_codes", "generic"]);
const providerModeSchema = z.enum(["auto", "openai", "right_codes", "generic"]);
const apiFormatSchema = z.enum(["chat_completions", "responses"]);
export const modelConfigKindSchema = z.enum(["openai_compatible", "pi_builtin"]);
const chatCompletionsToolStyleSchema = z.enum(["tools", "functions"]);
const responsesContinuationSchema = z.enum(["previous_response_id", "replay"]);
const responsesPayloadModeSchema = z.enum(["json", "sse", "auto"]);
const toolExecutionStatusSchema = z.enum(["success", "error"]);
const roomMessageRoleSchema = z.enum(["user", "assistant", "system"]);
const roomMessageSourceSchema = z.enum(["user", "agent_emit", "system"]);
const roomMessageKindSchema = z.enum(["user_input", "answer", "progress", "warning", "error", "clarification", "system"]);
const roomMessageStatusSchema = z.enum(["pending", "streaming", "completed", "failed"]);
const roomMessageReceiptStatusSchema = z.enum(["none", "read_no_reply"]);
const roomSenderRoleSchema = z.enum(["participant", "system"]);
const roomParticipantRuntimeKindSchema = z.enum(["human", "agent"]);
const agentTurnStatusSchema = z.enum(["running", "continued", "completed", "error"]);
const roomManagementActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_room"),
    roomId: z.string(),
    title: z.string(),
    agentIds: z.array(roomAgentIdSchema),
  }).strict(),
  z.object({
    type: z.literal("add_agents_to_room"),
    roomId: z.string(),
    agentIds: z.array(roomAgentIdSchema),
  }).strict(),
  z.object({
    type: z.literal("leave_room"),
    roomId: z.string(),
  }).strict(),
  z.object({
    type: z.literal("remove_room_participant"),
    roomId: z.string(),
    participantId: z.string(),
  }).strict(),
]);

export const providerCompatibilitySchema = z.object({
  providerKey: providerKeySchema,
  providerLabel: z.string(),
  baseUrl: z.string(),
  chatCompletionsToolStyle: chatCompletionsToolStyleSchema,
  responsesContinuation: responsesContinuationSchema,
  responsesPayloadMode: responsesPayloadModeSchema,
  notes: z.array(z.string()),
}).strict();

export const modelConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: modelConfigKindSchema,
  model: z.string(),
  apiFormat: apiFormatSchema,
  baseUrl: z.string(),
  providerMode: providerModeSchema,
  hasApiKey: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

const roomMessageReceiptSchema = z.object({
  participantId: z.string(),
  participantName: z.string(),
  agentId: roomAgentIdSchema.optional(),
  type: z.literal("read_no_reply"),
  createdAt: z.string(),
}).strict();

export const messageImageAttachmentSchema = z.object({
  id: z.string(),
  kind: z.literal("image"),
  mimeType: z.string(),
  filename: z.string(),
  sizeBytes: z.number().int().min(0),
  storagePath: z.string(),
  url: z.string(),
}).strict();

const roomSenderSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: roomSenderRoleSchema,
}).strict();

const roomParticipantSchema = z.object({
  id: z.string(),
  name: z.string(),
  senderRole: roomSenderRoleSchema,
  runtimeKind: roomParticipantRuntimeKindSchema,
  enabled: z.boolean(),
  order: z.number().int(),
  agentId: roomAgentIdSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

const roomMessageEmissionSchema = z.object({
  roomId: z.string(),
  messageKey: z.string().optional(),
  content: z.string(),
  kind: z.enum(["answer", "progress", "warning", "error", "clarification"]),
  status: roomMessageStatusSchema,
  final: z.boolean(),
}).strict();

const roomToolActionSchema = z.object({
  type: z.literal("read_no_reply"),
  roomId: z.string(),
  messageId: z.string(),
}).strict();

const roomToolActionUnionSchema = z.union([roomToolActionSchema, roomManagementActionSchema]);

const emptyCompletionDiagnosticSchema = z.object({
  createdAt: z.string(),
  apiFormat: apiFormatSchema,
  providerKey: providerKeySchema,
  providerLabel: z.string(),
  requestedModel: z.string(),
  resolvedModel: z.string(),
  baseUrl: z.string(),
  textDeltaLength: z.number(),
  finalTextLength: z.number(),
  toolCallCount: z.number(),
  toolEventCount: z.number(),
  payloadMode: responsesPayloadModeSchema.optional(),
  finishReason: z.string().nullable().optional(),
  responseId: z.string().optional(),
  assistantContentShape: z.string().optional(),
  outputItemTypes: z.array(z.string()).optional(),
  chunkCount: z.number().optional(),
  sawDoneEvent: z.boolean().optional(),
  chunkPreviews: z.array(z.string()).optional(),
}).strict();

const recoveryAttemptDiagnosticSchema = z.object({
  attempt: z.number(),
  strategy: z.enum(["retry_no_output", "resume_after_tools"]),
  trigger: z.literal("finish_reason_error"),
  delayMs: z.number(),
  toolEventCount: z.number(),
  finishReason: z.string().nullable().optional(),
  chunkCount: z.number().optional(),
  sawDoneEvent: z.boolean().optional(),
  chunkPreviews: z.array(z.string()).optional(),
}).strict();

const recoveryDiagnosticSchema = z.object({
  attempts: z.array(recoveryAttemptDiagnosticSchema),
}).strict();

const assistantUsageSnapshotSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
}).strict();

const assistantContinuationSnapshotSchema = z.object({
  strategy: responsesContinuationSchema,
  previousResponseId: z.string().optional(),
}).strict();

const assistantHistoryTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  textSignature: z.string().optional(),
}).strict();

const assistantHistoryThinkingPartSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
}).strict();

const assistantHistoryImagePartSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
}).strict();

const assistantHistoryToolCallPartSchema = z.object({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  partialJson: z.string().optional(),
  thoughtSignature: z.string().optional(),
}).strict();

const assistantHistoryUsageSnapshotSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }).strict(),
}).strict();

const assistantHistoryMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    content: z.union([
      z.string(),
      z.array(z.union([assistantHistoryTextPartSchema, assistantHistoryImagePartSchema])),
    ]),
    timestamp: z.number(),
  }).strict(),
  z.object({
    role: z.literal("assistant"),
    content: z.array(z.union([
      assistantHistoryTextPartSchema,
      assistantHistoryThinkingPartSchema,
      assistantHistoryToolCallPartSchema,
    ])),
    api: z.string(),
    provider: z.string(),
    model: z.string(),
    responseId: z.string().optional(),
    usage: assistantHistoryUsageSnapshotSchema,
    stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
    errorMessage: z.string().optional(),
    timestamp: z.number(),
  }).strict(),
  z.object({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(z.union([assistantHistoryTextPartSchema, assistantHistoryImagePartSchema])),
    details: z.unknown().optional(),
    isError: z.boolean(),
    timestamp: z.number(),
  }).strict(),
]);

export const assistantMessageMetaSchema = z.object({
  apiFormat: apiFormatSchema,
  compatibility: providerCompatibilitySchema,
  responseId: z.string().optional(),
  sessionId: z.string().optional(),
  continuation: assistantContinuationSnapshotSchema.optional(),
  usage: assistantUsageSnapshotSchema.optional(),
  historyDelta: z.array(assistantHistoryMessageSchema).optional(),
  emptyCompletion: emptyCompletionDiagnosticSchema.optional(),
  recovery: recoveryDiagnosticSchema.optional(),
}).strict();

const toolExecutionDetailsSchema = z.object({
  exitCode: z.number().nullable().optional(),
  truncated: z.boolean().optional(),
  fullOutputPath: z.string().optional(),
  cwd: z.string().optional(),
  shell: z.string().optional(),
  timedOut: z.boolean().optional(),
  aborted: z.boolean().optional(),
}).strict();

const toolExecutionSchema = z.object({
  id: z.string(),
  sequence: z.number(),
  toolName: z.string(),
  displayName: z.string(),
  inputSummary: z.string(),
  inputText: z.string(),
  resultPreview: z.string(),
  outputText: z.string(),
  status: toolExecutionStatusSchema,
  durationMs: z.number(),
  details: toolExecutionDetailsSchema.optional(),
  roomMessage: roomMessageEmissionSchema.optional(),
  roomAction: roomToolActionUnionSchema.optional(),
}).strict();

const roomMessageSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  seq: z.number().int(),
  role: roomMessageRoleSchema,
  sender: roomSenderSchema,
  content: z.string(),
  attachments: z.array(messageImageAttachmentSchema).default([]),
  source: roomMessageSourceSchema,
  kind: roomMessageKindSchema,
  status: roomMessageStatusSchema,
  final: z.boolean(),
  createdAt: z.string(),
  receipts: z.array(roomMessageReceiptSchema),
  receiptStatus: roomMessageReceiptStatusSchema,
  receiptUpdatedAt: z.string().nullable(),
}).strict();

const draftTextSegmentSchema = z.object({
  id: z.string(),
  sequence: z.number().int(),
  content: z.string(),
  status: z.enum(["streaming", "completed"]),
}).strict();

const turnTimelineEventSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    sequence: z.number().int(),
    type: z.literal("tool"),
    toolId: z.string(),
  }).strict(),
  z.object({
    id: z.string(),
    sequence: z.number().int(),
    type: z.literal("room-message"),
    messageId: z.string(),
    roomId: z.string(),
  }).strict(),
  z.object({
    id: z.string(),
    sequence: z.number().int(),
    type: z.literal("draft-segment"),
    segmentId: z.string(),
  }).strict(),
]);

const agentRoomTurnSchema = z.object({
  id: z.string(),
  agent: z.object({
    id: roomAgentIdSchema,
    label: z.string(),
  }).strict(),
  userMessage: roomMessageSchema,
  anchorMessageId: z.string().optional(),
  continuationSnapshot: z.string().optional(),
  assistantContent: z.string(),
  draftSegments: z.array(draftTextSegmentSchema).optional(),
  timeline: z.array(turnTimelineEventSchema).optional(),
  tools: z.array(toolExecutionSchema),
  emittedMessages: z.array(roomMessageSchema),
  status: agentTurnStatusSchema,
  meta: assistantMessageMetaSchema.optional(),
  resolvedModel: z.string().optional(),
  error: z.string().optional(),
}).strict();

const chatSettingsSchema = z.object({
  modelConfigId: z.string().nullable().optional().default(null),
  apiFormat: apiFormatSchema,
  model: z.string(),
  systemPrompt: z.string(),
  providerMode: providerModeSchema,
  memoryBackend: z.enum(MEMORY_BACKENDS).optional().default("sqlite-fts"),
  maxToolLoopSteps: z.number().int().min(MIN_MAX_TOOL_LOOP_STEPS).max(MAX_MAX_TOOL_LOOP_STEPS),
  thinkingLevel: z.enum(THINKING_LEVELS),
  enabledSkillIds: z.array(z.string()),
}).strict();

const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  attachments: z.array(messageImageAttachmentSchema).default([]),
  tools: z.array(toolExecutionSchema).optional(),
  meta: assistantMessageMetaSchema.optional(),
}).strict();

const agentSharedStateSchema = z.object({
  settings: chatSettingsSchema,
  agentTurns: z.array(agentRoomTurnSchema),
  resolvedModel: z.string(),
  compatibility: providerCompatibilitySchema.nullable(),
  updatedAt: z.string(),
}).strict();

const roomSchedulerStateSchema = z.object({
  status: z.enum(["idle", "running"]),
  nextAgentParticipantId: z.string().nullable(),
  activeParticipantId: z.string().nullable(),
  roundCount: z.number().int(),
  agentCursorByParticipantId: z.record(z.string(), z.number().int()),
  agentReceiptRevisionByParticipantId: z.record(z.string(), z.number().int()),
}).strict();

const roomSessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  agentId: roomAgentIdSchema,
  archivedAt: z.string().nullable(),
  ownerParticipantId: z.string().nullable(),
  receiptRevision: z.number().int(),
  participants: z.array(roomParticipantSchema),
  scheduler: roomSchedulerStateSchema,
  roomMessages: z.array(roomMessageSchema),
  agentTurns: z.array(agentRoomTurnSchema),
  error: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export const roomWorkspaceStateSchema = z.object({
  rooms: z.array(roomSessionSchema),
  agentStates: z.record(roomAgentIdSchema, agentSharedStateSchema),
  activeRoomId: z.string(),
  selectedConsoleAgentId: roomAgentIdSchema.optional(),
}).strict();

export const chatMessageRequestSchema = chatMessageSchema;

export function parseRoomWorkspaceState(value: unknown): RoomWorkspaceState {
  return roomWorkspaceStateSchema.parse(value);
}
