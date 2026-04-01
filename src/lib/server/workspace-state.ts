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

export function applyRoomTurnToWorkspace(args: ApplyRoomTurnToWorkspaceArgs) {
  let rooms = reduceRoomManagementActions(args.workspace.rooms, args.roomActions, args.agentId);

  rooms = rooms.map((room) => {
    if (room.id !== args.targetRoomId) {
      return room;
    }

    let nextRoom = {
      ...room,
      roomMessages: replaceUserMessageInRoom(room, args.turn),
      agentTurns: upsertAgentTurn(room.agentTurns, args.turn),
      error: args.turn.status === "error" ? args.turn.error || "Unknown room error." : "",
      updatedAt: createTimestamp(),
    };

    for (const receiptUpdate of args.receiptUpdates) {
      const nextMessages = applyMessageReceiptUpdate(nextRoom.roomMessages, receiptUpdate);
      if (nextMessages !== nextRoom.roomMessages) {
        nextRoom = {
          ...nextRoom,
          roomMessages: nextMessages,
          receiptRevision: nextRoom.receiptRevision + 1,
        };
      }
    }

    for (const emittedMessage of args.emittedMessages) {
      if (emittedMessage.roomId === nextRoom.id) {
        nextRoom = upsertMessageToRoom(nextRoom, emittedMessage);
      }
    }

    return nextRoom;
  });

  for (const emittedMessage of args.emittedMessages) {
    if (emittedMessage.roomId === args.targetRoomId) {
      continue;
    }
    rooms = rooms.map((room) => (room.id === emittedMessage.roomId ? upsertMessageToRoom(room, emittedMessage) : room));
  }

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

export function applyCronTurnToWorkspace(args: ApplyCronTurnToWorkspaceArgs) {
  let rooms = reduceRoomManagementActions(args.workspace.rooms, args.roomActions, args.agentId);

  rooms = rooms.map((room) => {
    if (room.id !== args.targetRoomId) {
      return room;
    }

    let nextRoom = {
      ...room,
      agentTurns: upsertAgentTurn(room.agentTurns, args.turn),
      error: "",
      updatedAt: createTimestamp(),
    };

    for (const receiptUpdate of args.receiptUpdates) {
      const nextMessages = applyMessageReceiptUpdate(nextRoom.roomMessages, receiptUpdate);
      if (nextMessages !== nextRoom.roomMessages) {
        nextRoom = {
          ...nextRoom,
          roomMessages: nextMessages,
          receiptRevision: nextRoom.receiptRevision + 1,
        };
      }
    }

    for (const emittedMessage of args.emittedMessages) {
      if (emittedMessage.roomId === nextRoom.id) {
        nextRoom = upsertMessageToRoom(nextRoom, emittedMessage);
      }
    }

    return nextRoom;
  });

  for (const emittedMessage of args.emittedMessages) {
    if (emittedMessage.roomId === args.targetRoomId) {
      continue;
    }
    rooms = rooms.map((room) => (room.id === emittedMessage.roomId ? upsertMessageToRoom(room, emittedMessage) : room));
  }

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
