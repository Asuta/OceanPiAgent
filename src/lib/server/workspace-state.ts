import type { AgentSharedState, ProviderCompatibility, RoomAgentId, RoomWorkspaceState } from "@/lib/chat/types";
import {
  applyMessageReceiptUpdate,
  createAgentSharedState,
  createTimestamp,
  reduceRoomManagementActions,
  sortRoomsByUpdatedAt,
  upsertMessageToRoom,
  type ApplyCronTurnToWorkspaceArgs,
} from "@/lib/chat/workspace-domain";

export * from "@/lib/chat/workspace-domain";

export type ApplyRoomTurnToWorkspaceArgs = {
  workspace: RoomWorkspaceState;
  agentId: RoomAgentId;
  targetRoomId: string;
  turn: import("@/lib/chat/types").RoomSession["agentTurns"][number];
  resolvedModel: string;
  compatibility: ProviderCompatibility;
  emittedMessages: import("@/lib/chat/types").RoomMessage[];
  receiptUpdates: import("@/lib/chat/types").RoomMessageReceiptUpdate[];
  roomActions: import("@/lib/chat/types").RoomToolActionUnion[];
};

type ApplyAgentTurnToWorkspaceArgs = ApplyRoomTurnToWorkspaceArgs;

function upsertAgentTurn(turns: ApplyRoomTurnToWorkspaceArgs["turn"][], turn: ApplyRoomTurnToWorkspaceArgs["turn"]) {
  const existingIndex = turns.findIndex((entry) => entry.id === turn.id);
  if (existingIndex < 0) {
    return [...turns, turn];
  }

  const nextTurns = [...turns];
  nextTurns[existingIndex] = turn;
  return nextTurns;
}

function replaceUserMessageInRoom(room: import("@/lib/chat/types").RoomSession, turn: ApplyRoomTurnToWorkspaceArgs["turn"]) {
  return room.roomMessages.map((message) => (
    message.id === turn.userMessage.id
      ? {
          ...turn.userMessage,
          seq: message.seq,
        }
      : message
  ));
}

function applyReceiptUpdatesToRoom(
  room: import("@/lib/chat/types").RoomSession,
  receiptUpdates: ApplyAgentTurnToWorkspaceArgs["receiptUpdates"],
) {
  let nextRoom = room;

  for (const receiptUpdate of receiptUpdates) {
    const nextMessages = applyMessageReceiptUpdate(nextRoom.roomMessages, receiptUpdate);
    if (nextMessages !== nextRoom.roomMessages) {
      nextRoom = {
        ...nextRoom,
        roomMessages: nextMessages,
        receiptRevision: nextRoom.receiptRevision + 1,
      };
    }
  }

  return nextRoom;
}

function applyEmittedMessagesToRoom(
  room: import("@/lib/chat/types").RoomSession,
  emittedMessages: ApplyAgentTurnToWorkspaceArgs["emittedMessages"],
) {
  let nextRoom = room;

  for (const emittedMessage of emittedMessages) {
    if (emittedMessage.roomId === nextRoom.id) {
      nextRoom = upsertMessageToRoom(nextRoom, emittedMessage);
    }
  }

  return nextRoom;
}

function applyCrossRoomEmittedMessages(
  rooms: import("@/lib/chat/types").RoomSession[],
  targetRoomId: string,
  emittedMessages: ApplyAgentTurnToWorkspaceArgs["emittedMessages"],
) {
  let nextRooms = rooms;

  for (const emittedMessage of emittedMessages) {
    if (emittedMessage.roomId === targetRoomId) {
      continue;
    }

    nextRooms = nextRooms.map((room) => (room.id === emittedMessage.roomId ? upsertMessageToRoom(room, emittedMessage) : room));
  }

  return nextRooms;
}

function applyAgentTurnLikeUpdate(
  args: ApplyAgentTurnToWorkspaceArgs,
  options: {
    replaceUserMessage: boolean;
    error: string;
  },
) {
  let rooms = reduceRoomManagementActions(args.workspace.rooms, args.roomActions, args.agentId);

  rooms = rooms.map((room) => {
    if (room.id !== args.targetRoomId) {
      return room;
    }

    let nextRoom = {
      ...room,
      roomMessages: options.replaceUserMessage ? replaceUserMessageInRoom(room, args.turn) : room.roomMessages,
      agentTurns: upsertAgentTurn(room.agentTurns, args.turn),
      error: options.error,
      updatedAt: createTimestamp(),
    };

    nextRoom = applyReceiptUpdatesToRoom(nextRoom, args.receiptUpdates);
    nextRoom = applyEmittedMessagesToRoom(nextRoom, args.emittedMessages);
    return nextRoom;
  });

  rooms = applyCrossRoomEmittedMessages(rooms, args.targetRoomId, args.emittedMessages);

  const nextAgentStates: Record<RoomAgentId, AgentSharedState> = {
    ...args.workspace.agentStates,
    [args.agentId]: {
      ...(args.workspace.agentStates[args.agentId] ?? createAgentSharedState()),
      agentTurns: upsertAgentTurn(args.workspace.agentStates[args.agentId]?.agentTurns ?? [], args.turn),
      resolvedModel: args.resolvedModel,
      compatibility: args.compatibility,
      updatedAt: createTimestamp(),
    },
  };

  return {
    ...args.workspace,
    rooms: sortRoomsByUpdatedAt(rooms),
    agentStates: nextAgentStates,
  };
}

export function applyRoomTurnToWorkspace(args: ApplyRoomTurnToWorkspaceArgs) {
  return applyAgentTurnLikeUpdate(args, {
    replaceUserMessage: true,
    error: args.turn.status === "error" ? args.turn.error || "Unknown room error." : "",
  });
}

export function applyCronTurnToWorkspace(args: ApplyCronTurnToWorkspaceArgs) {
  return applyAgentTurnLikeUpdate(args, {
    replaceUserMessage: false,
    error: "",
  });
}
