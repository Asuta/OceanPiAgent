import type { RoomAgentDefinition, RoomAgentId, RoomSession, RoomToolActionUnion } from "@/lib/chat/types";
import { reduceRoomManagementActions, sortRoomsForDisplay } from "@/lib/chat/workspace-domain";

export function applyRoomManagementActionsToRooms(args: {
  rooms: RoomSession[];
  actions: RoomToolActionUnion[];
  actorAgentId: RoomAgentId;
  agentDefinitions?: RoomAgentDefinition[];
}): RoomSession[] {
  return sortRoomsForDisplay(
    reduceRoomManagementActions(args.rooms, args.actions, args.actorAgentId, args.agentDefinitions),
  );
}
