import { createHash } from "node:crypto";
import { buildRoomBridgePrompt } from "@/lib/ai/system-prompt";
import type {
  AgentInfoCard,
  AgentRoomTurn,
  AssistantMessageMeta,
  AttachedRoomDefinition,
  ChatSettings,
  DraftTextSegment,
  MessageImageAttachment,
  ModelConfigExecutionOverrides,
  RoomAgentId,
  RoomChatResponseBody,
  RoomHistoryMessageSummary,
  RoomMessage,
  RoomMessageEmission,
  RoomMessagePreviewEmission,
  RoomMessageReceipt,
  RoomMessageReceiptStatus,
  RoomMessageReceiptUpdate,
  RoomSender,
  RoomSession,
  RoomToolActionUnion,
  RoomToolContext,
  ToolExecution,
  TurnTimelineEvent,
} from "@/lib/chat/types";
import { createUuid } from "@/lib/utils/uuid";
import {
  clearAgentRoomRun,
  completeAgentRoomRun,
  isCurrentAgentRun,
  recordAgentTextDelta,
  recordAgentToolEvent,
  startAgentRoomRun,
} from "@/lib/server/agent-room-sessions";
import {
  createAttachedRoomDefinition,
  createKnownAgentCards,
  createRoomHistorySummary,
  createTimestamp,
  getActiveRooms,
  getRoomAgent,
} from "@/lib/server/workspace-state";
import { listAgentDefinitions } from "@/lib/server/agent-registry";

function createAgentSender(agent: AgentRoomTurn["agent"]): RoomSender {
  return {
    id: agent.id,
    name: agent.label,
    role: "participant",
  };
}

function sortReceipts(receipts: RoomMessageReceipt[]): RoomMessageReceipt[] {
  return [...receipts].sort((left, right) => {
    const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }
    return left.participantName.localeCompare(right.participantName);
  });
}

function upsertReceipt(receipts: RoomMessageReceipt[], receipt: RoomMessageReceipt): RoomMessageReceipt[] {
  if (receipts.some((entry) => entry.participantId === receipt.participantId)) {
    return receipts;
  }
  const nextReceipts = receipts.filter((entry) => entry.participantId !== receipt.participantId);
  nextReceipts.push(receipt);
  return sortReceipts(nextReceipts);
}

function createReadNoReplyReceipt(agent: AgentRoomTurn["agent"], createdAt: string): RoomMessageReceipt {
  return {
    participantId: agent.id,
    participantName: agent.label,
    agentId: agent.id,
    type: "read_no_reply",
    createdAt,
  };
}

function createStreamedRoomMessageId(requestId: string, roomId: string, streamKey: string): string {
  const digest = createHash("sha1").update(`${requestId}:${roomId}:${streamKey}`).digest("hex").slice(0, 20);
  return `room-stream-${digest}`;
}

function createRoomMessageIdResolver(requestId: string) {
  const messageIdByToolCallId = new Map<string, string>();

  return (args: { roomId: string; messageKey?: string; toolCallId?: string }): string => {
    if (args.toolCallId) {
      const messageId = messageIdByToolCallId.get(args.toolCallId);
      if (messageId) {
        return messageId;
      }

      const nextMessageId = createStreamedRoomMessageId(requestId, args.roomId, `tool-call:${args.toolCallId}`);
      messageIdByToolCallId.set(args.toolCallId, nextMessageId);
      return nextMessageId;
    }

    if (args.messageKey) {
      return createStreamedRoomMessageId(requestId, args.roomId, `message-key:${args.roomId}:${args.messageKey}`);
    }

    return createUuid();
  };
}

function mergeEmittedMessages(messages: RoomMessage[], message: RoomMessage): RoomMessage[] {
  const existingIndex = messages.findIndex((entry) => entry.id === message.id);
  if (existingIndex < 0) {
    return [...messages, message];
  }

  const nextMessages = [...messages];
  nextMessages[existingIndex] = {
    ...nextMessages[existingIndex],
    ...message,
    id: nextMessages[existingIndex].id,
    roomId: nextMessages[existingIndex].roomId,
    seq: nextMessages[existingIndex].seq,
    role: nextMessages[existingIndex].role,
    sender: nextMessages[existingIndex].sender,
    source: nextMessages[existingIndex].source,
    createdAt: nextMessages[existingIndex].createdAt,
  };
  return nextMessages;
}

function createEmittedRoomMessage(
  message: RoomMessageEmission,
  agent: AgentRoomTurn["agent"],
  resolveRoomMessageId: ReturnType<typeof createRoomMessageIdResolver>,
  toolCallId?: string,
): RoomMessage {
  return {
    id: resolveRoomMessageId({
      roomId: message.roomId,
      ...(message.messageKey ? { messageKey: message.messageKey } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    }),
    roomId: message.roomId,
    seq: 0,
    role: "assistant",
    sender: createAgentSender(agent),
    content: message.content,
    attachments: [],
    source: "agent_emit",
    kind: message.kind,
    status: message.status,
    final: message.final,
    createdAt: createTimestamp(),
    receipts: [],
    receiptStatus: "none",
    receiptUpdatedAt: null,
  };
}

function createUserMessage(
  roomId: string,
  messageId: string,
  sender: RoomSender,
  content: string,
  attachments: MessageImageAttachment[],
  receipts: RoomMessageReceipt[],
  receiptStatus: RoomMessageReceiptStatus,
  receiptUpdatedAt: string | null,
): RoomMessage {
  const normalizedReceipts = sortReceipts(receipts);
  const latestReceipt = normalizedReceipts[normalizedReceipts.length - 1] ?? null;
  return {
    id: messageId,
    roomId,
    seq: 0,
    role: "user",
    sender,
    content,
    attachments: [...attachments],
    source: sender.role === "system" ? "system" : "user",
    kind: sender.role === "system" ? "system" : "user_input",
    status: "completed",
    final: true,
    createdAt: createTimestamp(),
    receipts: normalizedReceipts,
    receiptStatus: normalizedReceipts.length > 0 ? "read_no_reply" : receiptStatus,
    receiptUpdatedAt: latestReceipt?.createdAt ?? receiptUpdatedAt,
  };
}

function createMessageReceiptUpdate(
  roomId: string,
  messageId: string,
  receipt: RoomMessageReceipt,
): RoomMessageReceiptUpdate {
  return {
    roomId,
    messageId,
    receipt,
    receiptStatus: "read_no_reply",
    receiptUpdatedAt: receipt.createdAt,
  };
}

function createToolTimelineEvent(tool: ToolExecution, sequence: number): TurnTimelineEvent {
  return {
    id: `tool:${tool.id}`,
    sequence,
    type: "tool",
    toolId: tool.id,
  };
}

function createDraftSegmentTimelineEvent(segment: DraftTextSegment): TurnTimelineEvent {
  return {
    id: `draft-segment:${segment.id}`,
    sequence: segment.sequence,
    type: "draft-segment",
    segmentId: segment.id,
  };
}

function createRoomMessageTimelineEvent(message: RoomMessage, sequence: number): TurnTimelineEvent {
  return {
    id: `room-message:${message.id}`,
    sequence,
    type: "room-message",
    messageId: message.id,
    roomId: message.roomId,
  };
}

function appendDraftDelta(args: {
  draftSegments: DraftTextSegment[];
  timeline: TurnTimelineEvent[];
  delta: string;
}): { draftSegments: DraftTextSegment[]; timeline: TurnTimelineEvent[] } {
  const lastSegment = args.draftSegments[args.draftSegments.length - 1];
  if (lastSegment && lastSegment.status === "streaming") {
    const nextDraftSegments = [...args.draftSegments];
    nextDraftSegments[nextDraftSegments.length - 1] = {
      ...lastSegment,
      content: `${lastSegment.content}${args.delta}`,
    };
    return {
      draftSegments: nextDraftSegments,
      timeline: args.timeline,
    };
  }

  const segment: DraftTextSegment = {
    id: createUuid(),
    sequence: args.timeline.length + 1,
    content: args.delta,
    status: "streaming",
  };
  return {
    draftSegments: [...args.draftSegments, segment],
    timeline: [...args.timeline, createDraftSegmentTimelineEvent(segment)],
  };
}

function finalizeLatestDraftSegment(draftSegments: DraftTextSegment[]): DraftTextSegment[] {
  const lastSegment = draftSegments[draftSegments.length - 1];
  if (!lastSegment || lastSegment.status !== "streaming") {
    return draftSegments;
  }

  const nextDraftSegments = [...draftSegments];
  nextDraftSegments[nextDraftSegments.length - 1] = {
    ...lastSegment,
    status: "completed",
  };
  return nextDraftSegments;
}

function createTurn(
  agent: AgentRoomTurn["agent"],
  roomId: string,
  userMessageId: string,
  userSender: RoomSender,
  userContent: string,
  userAttachments: MessageImageAttachment[],
  anchorMessageId: string | undefined,
  userMessageReceipts: RoomMessageReceipt[],
  userMessageReceiptStatus: RoomMessageReceiptStatus,
  userMessageReceiptUpdatedAt: string | null,
  assistantContent: string,
  draftSegments: DraftTextSegment[],
  timeline: TurnTimelineEvent[],
  tools: ToolExecution[],
  emittedMessages: RoomMessage[],
  meta: AgentRoomTurn["meta"],
  resolvedModel: string,
  status: AgentRoomTurn["status"],
  continuationSnapshot?: string,
  error?: string,
): AgentRoomTurn {
  return {
    id: createUuid(),
    agent,
    userMessage: createUserMessage(
      roomId,
        userMessageId,
        userSender,
        userContent,
        userAttachments,
        userMessageReceipts,
      userMessageReceiptStatus,
      userMessageReceiptUpdatedAt,
    ),
    ...(anchorMessageId
      ? {
          anchorMessageId,
        }
      : {}),
    assistantContent,
    ...(draftSegments.length > 0
      ? {
          draftSegments,
        }
      : {}),
    timeline,
    tools,
    emittedMessages,
    status,
    meta,
    resolvedModel,
    ...(continuationSnapshot ? { continuationSnapshot } : {}),
    ...(error ? { error } : {}),
  };
}

function createToolContext(args: {
  roomId: string;
  agentId: RoomAgentId;
  attachedRooms: AttachedRoomDefinition[];
  knownAgents: AgentInfoCard[];
  roomHistoryById: Record<string, RoomHistoryMessageSummary[]>;
}): RoomToolContext {
  return {
    currentAgentId: args.agentId,
    currentRoomId: args.roomId,
    attachedRooms: args.attachedRooms.map((room) => ({
      ...room,
      participants: room.participants.map((participant) => ({ ...participant })),
    })),
    knownAgents: args.knownAgents.map((agent) => ({
      ...agent,
      skills: [...agent.skills],
    })),
    roomHistoryById: Object.fromEntries(
      Object.entries(args.roomHistoryById).map(([roomId, messages]) => [
        roomId,
        messages.map((message) => ({
          ...message,
          attachments: [...message.attachments],
          receipts: [...message.receipts],
        })),
      ]),
    ),
  };
}

function getAttachedRoomsForAgent(workspace: { rooms: RoomSession[] }, agentId: RoomAgentId, currentRoomId: string) {
  return getActiveRooms(workspace.rooms)
    .filter((room) => room.participants.some((participant) => participant.runtimeKind === "agent" && participant.agentId === agentId))
    .map((room) => createAttachedRoomDefinition(room, agentId))
    .map((room) => (room.id === currentRoomId ? { ...room } : room));
}

function getRoomHistoryByIdForAgent(workspace: { rooms: RoomSession[] }, agentId: RoomAgentId) {
  return Object.fromEntries(
    getActiveRooms(workspace.rooms)
      .filter((room) => room.participants.some((participant) => participant.runtimeKind === "agent" && participant.agentId === agentId))
      .map((room) => [room.id, createRoomHistorySummary(room)]),
  );
}

type RoomConversationRunner = (
  messages: Array<{ role: "user" | "assistant"; content: string; attachments?: MessageImageAttachment[]; meta?: AssistantMessageMeta }>,
  settings: ChatSettings,
  callbacks?: {
    onTextDelta?: (delta: string) => void;
    onTool?: (tool: ToolExecution) => void;
    onRoomMessagePreview?: (preview: RoomMessagePreviewEmission) => void;
  },
  options?: {
    toolScope?: "default" | "room";
    systemPromptOverride?: string;
    maxToolLoopSteps?: number;
    signal?: AbortSignal;
    toolContext?: RoomToolContext;
    modelConfigOverrides?: ModelConfigExecutionOverrides;
  },
  ) => Promise<{
  assistantText: string;
  toolEvents: ToolExecution[];
  resolvedModel: string;
  compatibility: AssistantMessageMeta["compatibility"];
  actualApiFormat: AssistantMessageMeta["apiFormat"];
  responseId?: NonNullable<AgentRoomTurn["meta"]>["responseId"];
  sessionId?: NonNullable<AgentRoomTurn["meta"]>["sessionId"];
  continuation?: NonNullable<AgentRoomTurn["meta"]>["continuation"];
  usage?: NonNullable<AgentRoomTurn["meta"]>["usage"];
  historyDelta?: NonNullable<AgentRoomTurn["meta"]>["historyDelta"];
  emptyCompletion?: NonNullable<AgentRoomTurn["meta"]>["emptyCompletion"];
  recovery?: NonNullable<AgentRoomTurn["meta"]>["recovery"];
}>;

async function resolveConversationDependencies(conversationRunner?: RoomConversationRunner) {
  if (conversationRunner) {
    return {
      conversationRunner,
      extractConversationErrorMeta: (error: unknown) => {
        void error;
        return undefined as AssistantMessageMeta | undefined;
      },
    };
  }

  const conversationModule = await import("../ai/openai-client");
  return {
    conversationRunner: conversationModule.streamConversation as RoomConversationRunner,
    extractConversationErrorMeta: conversationModule.extractAssistantMetaFromConversationError,
  };
}

interface BaseRoomTurnInput {
  message: {
    id: string;
    content: string;
    attachments: MessageImageAttachment[];
    sender: RoomSender;
  };
  settings: ChatSettings;
  room: {
    id: string;
    title: string;
  };
  agent: {
    id: RoomAgentId;
    label: string;
    instruction: string;
  };
  attachedRooms: AttachedRoomDefinition[];
  knownAgents: AgentInfoCard[];
  roomHistoryById: Record<string, RoomHistoryMessageSummary[]>;
  anchorMessageId?: string;
  modelConfigOverrides?: ModelConfigExecutionOverrides;
  signal?: AbortSignal;
  conversationRunner?: RoomConversationRunner;
}

export type RunPreparedRoomTurnInput = BaseRoomTurnInput;

export interface RunRoomTurnInput {
  workspace: { rooms: RoomSession[] };
  roomId: string;
  agentId: RoomAgentId;
  message: BaseRoomTurnInput["message"];
  anchorMessageId?: string;
  settings: ChatSettings;
  signal?: AbortSignal;
}

export interface RunRoomTurnResult extends RoomChatResponseBody {
  roomActions: RoomToolActionUnion[];
}

export interface RoomTurnCallbacks {
  onTextDelta?: (delta: string) => void;
  onTool?: (tool: ToolExecution) => void;
  onRoomMessagePreview?: (message: RoomMessage) => void;
  onRoomMessage?: (message: RoomMessage) => void;
  onReceiptUpdate?: (update: RoomMessageReceiptUpdate) => void;
}

class RoomTurnExecutionError extends Error {
  assistantMeta?: AssistantMessageMeta;
  partial: {
    agent: AgentRoomTurn["agent"];
    roomId: string;
    userMessageId: string;
    userSender: RoomSender;
    userContent: string;
    userAttachments: MessageImageAttachment[];
    anchorMessageId?: string;
    toolEvents: ToolExecution[];
    emittedMessages: RoomMessage[];
    receiptUpdates: RoomMessageReceiptUpdate[];
    draftSegments: DraftTextSegment[];
    timeline: TurnTimelineEvent[];
    currentUserReceipts: RoomMessageReceipt[];
    currentUserReceiptStatus: RoomMessageReceiptStatus;
    currentUserReceiptUpdatedAt: string | null;
    resolvedModel: string;
    continuationSnapshot?: string;
  };

  constructor(
    message: string,
    partial: RoomTurnExecutionError["partial"],
    assistantMeta?: AssistantMessageMeta,
  ) {
    super(message);
    this.name = "RoomTurnExecutionError";
    this.partial = partial;
    this.assistantMeta = assistantMeta;
  }
}

export async function buildPreparedInputFromWorkspace(args: RunRoomTurnInput): Promise<RunPreparedRoomTurnInput> {
  const room = args.workspace.rooms.find((entry) => entry.id === args.roomId);
  if (!room) {
    throw new Error(`Room ${args.roomId} does not exist.`);
  }

  const agentDefinitions = await listAgentDefinitions();
  const agentDef = getRoomAgent(args.agentId, agentDefinitions);
  return {
    message: args.message,
    settings: args.settings,
    room: {
      id: room.id,
      title: room.title,
    },
    agent: {
      id: agentDef.id,
      label: agentDef.label,
      instruction: agentDef.instruction,
    },
    attachedRooms: getAttachedRoomsForAgent(args.workspace, args.agentId, room.id),
    knownAgents: createKnownAgentCards(agentDefinitions),
    roomHistoryById: getRoomHistoryByIdForAgent(args.workspace, args.agentId),
    anchorMessageId: args.anchorMessageId,
    signal: args.signal,
  };
}

export function extractAssistantMetaFromRoomTurnError(error: unknown): AssistantMessageMeta | undefined {
  return error instanceof RoomTurnExecutionError ? error.assistantMeta : undefined;
}

export async function runPreparedRoomTurn(
  args: RunPreparedRoomTurnInput,
  callbacks?: RoomTurnCallbacks,
): Promise<RunRoomTurnResult> {
  const { conversationRunner, extractConversationErrorMeta } = await resolveConversationDependencies(args.conversationRunner);
  const agent = { id: args.agent.id, label: args.agent.label } satisfies AgentRoomTurn["agent"];
  const toolContext = createToolContext({
    roomId: args.room.id,
    agentId: args.agent.id,
    attachedRooms: args.attachedRooms,
    knownAgents: args.knownAgents,
    roomHistoryById: args.roomHistoryById,
  });

  const promptOverride = buildRoomBridgePrompt({
    operatorPrompt: args.settings.systemPrompt,
    roomId: args.room.id,
    roomTitle: args.room.title,
    agentLabel: args.agent.label,
    agentInstruction: args.agent.instruction,
    attachedRooms: args.attachedRooms,
  });

  const requestController = new AbortController();
  const runContext = await startAgentRoomRun({
    agentId: args.agent.id,
    roomId: args.room.id,
    roomTitle: args.room.title,
    attachedRooms: args.attachedRooms.map((attachedRoom) => ({
      id: attachedRoom.id,
      title: attachedRoom.title,
      archived: attachedRoom.archived,
    })),
    userMessageId: args.message.id,
    userSender: args.message.sender,
    userContent: args.message.content,
    userAttachments: args.message.attachments,
    requestSignal: args.signal ?? requestController.signal,
  });

  const toolEvents: ToolExecution[] = [];
  const emittedMessages: RoomMessage[] = [];
  const receiptUpdates: RoomMessageReceiptUpdate[] = [];
  const timeline: TurnTimelineEvent[] = [];
  let draftSegments: DraftTextSegment[] = [];
  const resolveRoomMessageId = createRoomMessageIdResolver(runContext.requestId);
  let currentUserReceiptStatus: RoomMessageReceiptStatus = "none";
  let currentUserReceiptUpdatedAt: string | null = null;
  let currentUserReceipts: RoomMessageReceipt[] = [];

  try {
    const conversationHistory =
      args.message.attachments.length > 0
        ? [
            ...runContext.history.slice(0, -1),
            {
              ...runContext.history[runContext.history.length - 1],
              attachments: [...args.message.attachments],
            },
          ]
        : runContext.history;
    const result = await conversationRunner(
      conversationHistory,
      args.settings,
      {
        onTextDelta: (delta) => {
          if (!isCurrentAgentRun(args.agent.id, runContext.requestId)) {
            return;
          }
          recordAgentTextDelta(args.agent.id, runContext.requestId, delta);
          const nextDraftState = appendDraftDelta({
            draftSegments,
            timeline,
            delta,
          });
          draftSegments = nextDraftState.draftSegments;
          timeline.splice(0, timeline.length, ...nextDraftState.timeline);
          callbacks?.onTextDelta?.(delta);
        },
        onRoomMessagePreview: (preview: RoomMessagePreviewEmission) => {
          if (!isCurrentAgentRun(args.agent.id, runContext.requestId)) {
            return;
          }

          const previewMessage = createEmittedRoomMessage(
            {
              roomId: preview.roomId,
              ...(preview.messageKey ? { messageKey: preview.messageKey } : {}),
              content: preview.content,
              kind: preview.kind,
              status: "streaming",
              final: false,
            },
            agent,
            resolveRoomMessageId,
            preview.toolCallId,
          );
          callbacks?.onRoomMessagePreview?.(previewMessage);
        },
        onTool: (tool) => {
          if (!isCurrentAgentRun(args.agent.id, runContext.requestId)) {
            return;
          }

          draftSegments = finalizeLatestDraftSegment(draftSegments);
          toolEvents.push(tool);
          timeline.push(createToolTimelineEvent(tool, timeline.length + 1));
          recordAgentToolEvent(args.agent.id, runContext.requestId, tool);
          callbacks?.onTool?.(tool);

          if (tool.roomMessage) {
            const roomMessage = createEmittedRoomMessage(tool.roomMessage, agent, resolveRoomMessageId, tool.id);
            const alreadySeenMessage = emittedMessages.some((entry) => entry.id === roomMessage.id);
            emittedMessages.splice(0, emittedMessages.length, ...mergeEmittedMessages(emittedMessages, roomMessage));
            if (!alreadySeenMessage) {
              timeline.push(createRoomMessageTimelineEvent(roomMessage, timeline.length + 1));
            }
            callbacks?.onRoomMessage?.(roomMessage);
          }

          if (tool.roomAction?.type === "read_no_reply" && tool.roomAction.roomId && tool.roomAction.messageId) {
            const receiptUpdatedAt = createTimestamp();
            const receipt = createReadNoReplyReceipt(agent, receiptUpdatedAt);
            const receiptUpdate = createMessageReceiptUpdate(tool.roomAction.roomId, tool.roomAction.messageId, receipt);
            receiptUpdates.push(receiptUpdate);
            callbacks?.onReceiptUpdate?.(receiptUpdate);

            if (tool.roomAction.roomId === args.room.id && tool.roomAction.messageId === args.message.id) {
              currentUserReceiptStatus = "read_no_reply";
              currentUserReceiptUpdatedAt = receiptUpdatedAt;
              currentUserReceipts = upsertReceipt(currentUserReceipts, receipt);
            }
          }
        },
      },
      {
        toolScope: "room",
        systemPromptOverride: promptOverride,
        signal: runContext.signal,
        toolContext,
        modelConfigOverrides: args.modelConfigOverrides,
      },
    );

    await completeAgentRoomRun({
      agentId: args.agent.id,
      requestId: runContext.requestId,
      assistantText: result.assistantText,
      resolvedModel: result.resolvedModel,
      compatibility: result.compatibility,
      meta: {
        apiFormat: result.actualApiFormat,
        compatibility: result.compatibility,
        ...(result.responseId ? { responseId: result.responseId } : {}),
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.continuation ? { continuation: result.continuation } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.historyDelta ? { historyDelta: result.historyDelta } : {}),
        ...(result.recovery ? { recovery: result.recovery } : {}),
        ...(result.emptyCompletion ? { emptyCompletion: result.emptyCompletion } : {}),
      },
    });

    const turn = createTurn(
      agent,
      args.room.id,
      args.message.id,
      args.message.sender,
      args.message.content,
      args.message.attachments,
      args.anchorMessageId,
      currentUserReceipts,
      currentUserReceiptStatus,
      currentUserReceiptUpdatedAt,
      result.assistantText,
      finalizeLatestDraftSegment(draftSegments),
      timeline,
      toolEvents.length > 0 ? toolEvents : result.toolEvents,
      emittedMessages,
      {
        apiFormat: result.actualApiFormat,
        compatibility: result.compatibility,
        ...(result.responseId ? { responseId: result.responseId } : {}),
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.continuation ? { continuation: result.continuation } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.historyDelta ? { historyDelta: result.historyDelta } : {}),
        ...(result.recovery ? { recovery: result.recovery } : {}),
        ...(result.emptyCompletion ? { emptyCompletion: result.emptyCompletion } : {}),
      },
      result.resolvedModel,
      "completed",
      runContext.continuationSnapshot,
    );

    return {
      turn,
      resolvedModel: result.resolvedModel,
      compatibility: result.compatibility,
      emittedMessages,
      receiptUpdates,
      roomActions: turn.tools.flatMap((tool) => (tool.roomAction ? [tool.roomAction] : [])),
    };
  } catch (error) {
    clearAgentRoomRun(args.agent.id, runContext.requestId);
    const message = error instanceof Error ? error.message : "Unknown server error.";
    throw new RoomTurnExecutionError(
      message,
      {
        agent,
        roomId: args.room.id,
        userMessageId: args.message.id,
        userSender: args.message.sender,
        userContent: args.message.content,
        userAttachments: args.message.attachments,
        anchorMessageId: args.anchorMessageId,
        toolEvents,
        emittedMessages,
        receiptUpdates,
        draftSegments: finalizeLatestDraftSegment(draftSegments),
        timeline,
        currentUserReceipts,
        currentUserReceiptStatus,
        currentUserReceiptUpdatedAt,
        resolvedModel: runContext.resolvedModel,
        continuationSnapshot: runContext.continuationSnapshot,
      },
      extractConversationErrorMeta(error),
    );
  }
}

export async function runRoomTurnNonStreaming(args: RunRoomTurnInput): Promise<RunRoomTurnResult> {
  try {
    return await runPreparedRoomTurn(await buildPreparedInputFromWorkspace(args));
  } catch (error) {
    if (!(error instanceof RoomTurnExecutionError)) {
      throw error;
    }

    return {
      turn: createTurn(
        error.partial.agent,
        error.partial.roomId,
        error.partial.userMessageId,
        error.partial.userSender,
        error.partial.userContent,
        error.partial.userAttachments,
        error.partial.anchorMessageId,
        error.partial.currentUserReceipts,
        error.partial.currentUserReceiptStatus,
        error.partial.currentUserReceiptUpdatedAt,
        "",
        error.partial.draftSegments,
        error.partial.timeline,
        error.partial.toolEvents,
        error.partial.emittedMessages,
        error.assistantMeta,
        error.partial.resolvedModel,
        "error",
        error.partial.continuationSnapshot,
        error.message,
      ),
      resolvedModel: error.partial.resolvedModel,
      compatibility: error.assistantMeta?.compatibility ?? {
        providerKey: "openai",
        providerLabel: "Unknown",
        baseUrl: "",
        chatCompletionsToolStyle: "tools",
        responsesContinuation: "replay",
        responsesPayloadMode: "json",
        notes: [],
      },
      emittedMessages: error.partial.emittedMessages,
      receiptUpdates: error.partial.receiptUpdates,
      roomActions: error.partial.toolEvents.flatMap((tool) => (tool.roomAction ? [tool.roomAction] : [])),
    };
  }
}
