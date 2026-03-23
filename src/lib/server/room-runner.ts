import { buildRoomBridgePrompt } from "@/lib/ai/system-prompt";
import { extractAssistantMetaFromConversationError, streamConversation } from "@/lib/ai/openai-client";
import {
  clearAgentRoomRun,
  completeAgentRoomRun,
  isCurrentAgentRun,
  recordAgentTextDelta,
  recordAgentToolEvent,
  startAgentRoomRun,
} from "@/lib/server/agent-room-sessions";
import type {
  AgentRoomTurn,
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
  ToolExecution,
} from "@/lib/chat/types";
import { createAttachedRoomDefinition, createKnownAgentCards, createRoomHistorySummary, createTimestamp, getActiveRooms, getRoomAgent } from "@/lib/server/workspace-state";

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
    id: crypto.randomUUID(),
    roomId: message.roomId,
    seq: 0,
    role: "assistant",
    sender: createAgentSender(agent),
    content: message.content,
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
  userMessageReceipts: RoomMessageReceipt[],
  userMessageReceiptStatus: RoomMessageReceiptStatus,
  userMessageReceiptUpdatedAt: string | null,
  assistantContent: string,
  tools: ToolExecution[],
  emittedMessages: RoomMessage[],
  meta: AgentRoomTurn["meta"],
  resolvedModel: string,
  status: AgentRoomTurn["status"],
  error?: string,
): AgentRoomTurn {
  return {
    id: crypto.randomUUID(),
    agent,
    userMessage: createUserMessage(
      roomId,
      userMessageId,
      userSender,
      userContent,
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
    ...(error ? { error } : {}),
  };
}

function createToolContext(args: {
  room: RoomSession;
  agentId: RoomAgentId;
  attachedRooms: ReturnType<typeof createAttachedRoomDefinition>[];
  roomHistoryById: Record<string, RoomHistoryMessageSummary[]>;
}) {
  return {
    currentAgentId: args.agentId,
    currentRoomId: args.room.id,
    attachedRooms: args.attachedRooms.map((room) => ({
      ...room,
      participants: room.participants.map((participant) => ({ ...participant })),
    })),
    knownAgents: createKnownAgentCards(),
    roomHistoryById: Object.fromEntries(
      Object.entries(args.roomHistoryById).map(([roomId, messages]) => [
        roomId,
        messages.map((message) => ({
          ...message,
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

export interface RunRoomTurnInput {
  workspace: { rooms: RoomSession[] };
  roomId: string;
  agentId: RoomAgentId;
  message: {
    id: string;
    content: string;
    sender: RoomSender;
  };
  settings: {
    apiFormat: "chat_completions" | "responses";
    model: string;
    systemPrompt: string;
    providerMode: "auto" | "openai" | "right_codes" | "generic";
    maxToolLoopSteps: number;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    enabledSkillIds: string[];
  };
  signal?: AbortSignal;
}

export interface RunRoomTurnResult extends RoomChatResponseBody {
  roomActions: RoomToolActionUnion[];
}

export async function runRoomTurnNonStreaming(args: RunRoomTurnInput): Promise<RunRoomTurnResult> {
  const room = args.workspace.rooms.find((entry) => entry.id === args.roomId);
  if (!room) {
    throw new Error(`Room ${args.roomId} does not exist.`);
  }

  const agentDef = getRoomAgent(args.agentId);
  const agent = { id: agentDef.id, label: agentDef.label } satisfies AgentRoomTurn["agent"];
  const attachedRooms = getAttachedRoomsForAgent(args.workspace, args.agentId, room.id);
  const roomHistoryById = getRoomHistoryByIdForAgent(args.workspace, args.agentId);
  const toolContext = createToolContext({
    room,
    agentId: args.agentId,
    attachedRooms,
    roomHistoryById,
  });

  const promptOverride = buildRoomBridgePrompt({
    operatorPrompt: args.settings.systemPrompt,
    roomId: room.id,
    roomTitle: room.title,
    agentLabel: agentDef.label,
    agentInstruction: agentDef.instruction,
    attachedRooms,
  });

  const requestController = new AbortController();
  const runContext = await startAgentRoomRun({
    agentId: args.agentId,
    roomId: room.id,
    roomTitle: room.title,
    attachedRooms: attachedRooms.map((attachedRoom) => ({
      id: attachedRoom.id,
      title: attachedRoom.title,
      archived: attachedRoom.archived,
    })),
    userMessageId: args.message.id,
    userSender: args.message.sender,
    userContent: args.message.content,
    requestSignal: args.signal ?? requestController.signal,
  });

  const toolEvents: ToolExecution[] = [];
  const emittedMessages: RoomMessage[] = [];
  const receiptUpdates: RoomMessageReceiptUpdate[] = [];
  let currentUserReceiptStatus: RoomMessageReceiptStatus = "none";
  let currentUserReceiptUpdatedAt: string | null = null;
  let currentUserReceipts: RoomMessageReceipt[] = [];

  try {
    const result = await streamConversation(
      runContext.history,
      args.settings,
      {
        onTextDelta: (delta) => {
          if (!isCurrentAgentRun(args.agentId, runContext.requestId)) {
            return;
          }
          recordAgentTextDelta(args.agentId, runContext.requestId, delta);
        },
        onTool: (tool) => {
          if (!isCurrentAgentRun(args.agentId, runContext.requestId)) {
            return;
          }

          toolEvents.push(tool);
          recordAgentToolEvent(args.agentId, runContext.requestId, tool);
          if (tool.roomMessage) {
            emittedMessages.push(createEmittedRoomMessage(tool.roomMessage, agent));
          }
          if (tool.roomAction?.type === "read_no_reply" && tool.roomAction.roomId && tool.roomAction.messageId) {
            const receiptUpdatedAt = createTimestamp();
            const receipt = createReadNoReplyReceipt(agent, receiptUpdatedAt);
            receiptUpdates.push(createMessageReceiptUpdate(tool.roomAction.roomId, tool.roomAction.messageId, receipt));
            if (tool.roomAction.roomId === room.id && tool.roomAction.messageId === args.message.id) {
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
      },
    );

    await completeAgentRoomRun({
      agentId: args.agentId,
      requestId: runContext.requestId,
      assistantText: result.assistantText,
      resolvedModel: result.resolvedModel,
      compatibility: result.compatibility,
    });

    const turn = createTurn(
      agent,
      room.id,
      args.message.id,
      args.message.sender,
      args.message.content,
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
    clearAgentRoomRun(args.agentId, runContext.requestId);
    const message = error instanceof Error ? error.message : "Unknown server error.";
    const meta = extractAssistantMetaFromConversationError(error);

    return {
      turn: createTurn(
        agent,
        room.id,
        args.message.id,
        args.message.sender,
        args.message.content,
        currentUserReceipts,
        currentUserReceiptStatus,
        currentUserReceiptUpdatedAt,
        "",
        toolEvents,
        emittedMessages,
        meta,
        runContext.resolvedModel,
        "error",
        message,
      ),
      resolvedModel: runContext.resolvedModel,
      compatibility: runContext.compatibility ?? {
        providerKey: "openai",
        providerLabel: "Unknown",
        baseUrl: "",
        chatCompletionsToolStyle: "tools",
        responsesContinuation: "replay",
        responsesPayloadMode: "json",
        notes: [],
      },
      emittedMessages,
      receiptUpdates,
      roomActions: toolEvents.flatMap((tool) => (tool.roomAction ? [tool.roomAction] : [])),
    };
  }
}
