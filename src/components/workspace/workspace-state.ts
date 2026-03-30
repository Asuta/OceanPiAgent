import type { AgentSharedState, RoomAgentId, RoomSession, RoomWorkspaceState } from "@/lib/chat/types";

export function buildWorkspaceStateSnapshot(args: {
  rooms: RoomSession[];
  agentStates: Record<RoomAgentId, AgentSharedState>;
  activeRoomId: string;
  selectedConsoleAgentId?: RoomAgentId | null;
}): RoomWorkspaceState {
  return {
    rooms: args.rooms,
    agentStates: args.agentStates,
    activeRoomId: args.activeRoomId,
    ...(args.selectedConsoleAgentId ? { selectedConsoleAgentId: args.selectedConsoleAgentId } : {}),
  };
}

export function workspaceStatesEqual(left: RoomWorkspaceState, right: RoomWorkspaceState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function conflictRoomContainsLocalMessages(localRoom: RoomSession, conflictRoom: RoomSession): boolean {
  const conflictMessageIds = new Set(conflictRoom.roomMessages.map((message) => message.id));
  return localRoom.roomMessages.every((message) => conflictMessageIds.has(message.id));
}

export function canApplyConflictWorkspaceSnapshot(args: {
  localState: RoomWorkspaceState;
  conflictState: RoomWorkspaceState;
}): boolean {
  const conflictRoomsById = new Map(args.conflictState.rooms.map((room) => [room.id, room]));

  if (args.localState.activeRoomId && !conflictRoomsById.has(args.localState.activeRoomId)) {
    return false;
  }

  return args.localState.rooms.every((localRoom) => {
    const conflictRoom = conflictRoomsById.get(localRoom.id);
    if (!conflictRoom) {
      return false;
    }

    return conflictRoomContainsLocalMessages(localRoom, conflictRoom);
  });
}
