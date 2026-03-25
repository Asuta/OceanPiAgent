import type { AgentSharedState, RoomAgentId } from "@/lib/chat/types";
import {
  applyMessageReceiptUpdate,
  appendMessageToRoom,
  createAgentSharedState,
  createTimestamp,
  reduceRoomManagementActions,
  sortRoomsByUpdatedAt,
  type ApplyCronTurnToWorkspaceArgs,
} from "@/lib/chat/workspace-domain";

export * from "@/lib/chat/workspace-domain";

export function applyCronTurnToWorkspace(args: ApplyCronTurnToWorkspaceArgs) {
  let rooms = reduceRoomManagementActions(args.workspace.rooms, args.roomActions, args.agentId);

  rooms = rooms.map((room) => {
    if (room.id !== args.targetRoomId) {
      return room;
    }

    let nextRoom = {
      ...room,
      agentTurns: [...room.agentTurns, args.turn],
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
        nextRoom = appendMessageToRoom(nextRoom, emittedMessage);
      }
    }

    return nextRoom;
  });

  for (const emittedMessage of args.emittedMessages) {
    if (emittedMessage.roomId === args.targetRoomId) {
      continue;
    }
    rooms = rooms.map((room) => (room.id === emittedMessage.roomId ? appendMessageToRoom(room, emittedMessage) : room));
  }

  const nextAgentStates: Record<RoomAgentId, AgentSharedState> = {
    ...args.workspace.agentStates,
    [args.agentId]: {
      ...(args.workspace.agentStates[args.agentId] ?? createAgentSharedState()),
      agentTurns: [...(args.workspace.agentStates[args.agentId]?.agentTurns ?? []), args.turn],
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
