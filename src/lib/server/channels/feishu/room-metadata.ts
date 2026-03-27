import { createTimestamp } from "@/lib/chat/workspace-domain";
import type { RoomSession } from "@/lib/chat/types";
import type { ChannelBinding } from "@/lib/server/channels/types";

export function buildFeishuRoomTitle(senderName: string, peerId: string): string {
  const label = senderName.trim() || peerId.trim();
  return `Feishu - ${label}`;
}

export function applyFeishuRoomMetadata(room: RoomSession, binding: ChannelBinding, senderName: string): RoomSession {
  const normalizedName = senderName.trim() || binding.peerId;
  const timestamp = createTimestamp();
  return {
    ...room,
    title: buildFeishuRoomTitle(normalizedName, binding.peerId),
    participants: room.participants.map((participant) => (
      participant.id === binding.humanParticipantId
        ? {
            ...participant,
            name: normalizedName,
            updatedAt: timestamp,
          }
        : participant
    )),
    updatedAt: timestamp,
  };
}
