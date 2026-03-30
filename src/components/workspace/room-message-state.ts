import type { RoomMessage, RoomSession } from "@/lib/chat/types";
import { upsertMessageToRoom } from "@/lib/chat/workspace-domain";

export function appendMissingMatchingRoomMessages(room: RoomSession, messages: RoomMessage[]): RoomSession {
  let nextRoom = room;

  for (const message of messages) {
    if (message.roomId !== room.id) {
      continue;
    }

    nextRoom = upsertMessageToRoom(nextRoom, message);
  }

  return nextRoom;
}
