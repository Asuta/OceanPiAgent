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
