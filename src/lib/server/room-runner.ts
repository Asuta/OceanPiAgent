import { buildRoomBridgePrompt } from "@/lib/ai/system-prompt";
import type {
  AgentInfoCard,
  AgentRoomTurn,
  AssistantMessageMeta,
  AttachedRoomDefinition,
  ChatSettings,
  MessageImageAttachment,
  ModelConfigExecutionOverrides,
  RoomAgentId,
  RoomChatResponseBody,
  RoomHistoryMessageSummary,
  RoomMessage,
  RoomMessageEmission,
  RoomMessageReceipt,
  RoomMessageReceiptStatus,
  RoomMessageReceiptUpdate,
  RoomSender,
  RoomSession,
  RoomToolActionUnion,
  RoomToolContext,
  ToolExecution,
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

function createEmittedRoomMessage(message: RoomMessageEmission, agent: AgentRoomTurn["agent"]): RoomMessage {
  return {
    id: createUuid(),
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

function createTurn(
  agent: AgentRoomTurn["agent"],
  roomId: string,
  userMessageId: string,
  userSender: RoomSender,
  userContent: string,
  userAttachments: MessageImageAttachment[],
  userMessageReceipts: RoomMessageReceipt[],
  userMessageReceiptStatus: RoomMessageReceiptStatus,
  userMessageReceiptUpdatedAt: string | null,
  assistantContent: string,
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
    assistantContent,
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
  messages: Array<{ role: "user" | "assistant"; content: string; attachments?: MessageImageAttachment[] }>,
  settings: ChatSettings,
  callbacks?: {
    onTextDelta?: (delta: string) => void;
    onTool?: (tool: ToolExecution) => void;
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
  settings: ChatSettings;
  signal?: AbortSignal;
}

export interface RunRoomTurnResult extends RoomChatResponseBody {
  roomActions: RoomToolActionUnion[];
}

export interface RoomTurnCallbacks {
  onTextDelta?: (delta: string) => void;
  onTool?: (tool: ToolExecution) => void;
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
    toolEvents: ToolExecution[];
    emittedMessages: RoomMessage[];
    receiptUpdates: RoomMessageReceiptUpdate[];
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

function buildPreparedInputFromWorkspace(args: RunRoomTurnInput): RunPreparedRoomTurnInput {
  const room = args.workspace.rooms.find((entry) => entry.id === args.roomId);
  if (!room) {
    throw new Error(`Room ${args.roomId} does not exist.`);
  }

  const agentDef = getRoomAgent(args.agentId);
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
    knownAgents: createKnownAgentCards(),
    roomHistoryById: getRoomHistoryByIdForAgent(args.workspace, args.agentId),
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
          callbacks?.onTextDelta?.(delta);
        },
        onTool: (tool) => {
          if (!isCurrentAgentRun(args.agent.id, runContext.requestId)) {
            return;
          }

          toolEvents.push(tool);
          recordAgentToolEvent(args.agent.id, runContext.requestId, tool);
          callbacks?.onTool?.(tool);

          if (tool.roomMessage) {
            const roomMessage = createEmittedRoomMessage(tool.roomMessage, agent);
            emittedMessages.push(roomMessage);
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
    });

    const turn = createTurn(
      agent,
      args.room.id,
      args.message.id,
      args.message.sender,
      args.message.content,
      args.message.attachments,
      currentUserReceipts,
      currentUserReceiptStatus,
      currentUserReceiptUpdatedAt,
      result.assistantText,
      toolEvents.length > 0 ? toolEvents : result.toolEvents,
      emittedMessages,
      {
        apiFormat: result.actualApiFormat,
        compatibility: result.compatibility,
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
        toolEvents,
        emittedMessages,
        receiptUpdates,
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
    return await runPreparedRoomTurn(buildPreparedInputFromWorkspace(args));
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
        error.partial.currentUserReceipts,
        error.partial.currentUserReceiptStatus,
        error.partial.currentUserReceiptUpdatedAt,
        "",
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
