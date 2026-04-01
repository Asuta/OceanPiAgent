import type { AgentRoomTurn, RoomMessage } from "@/lib/chat/types";

function mergeTurnRoomMessage(existing: RoomMessage, next: RoomMessage): RoomMessage {
  return {
    ...existing,
    ...next,
    id: existing.id,
    roomId: existing.roomId,
    seq: existing.seq,
    role: existing.role,
    sender: existing.sender,
    source: existing.source,
    createdAt: existing.createdAt,
  };
}

function upsertTurnEmittedMessages(messages: RoomMessage[], message: RoomMessage): RoomMessage[] {
  const existingIndex = messages.findIndex((entry) => entry.id === message.id);
  if (existingIndex < 0) {
    return [...messages, message];
  }

  const nextMessages = [...messages];
  nextMessages[existingIndex] = mergeTurnRoomMessage(nextMessages[existingIndex]!, message);
  return nextMessages;
}

export function upsertRoomMessageInTurn(turn: AgentRoomTurn, message: RoomMessage): AgentRoomTurn {
  const nextMessages = upsertTurnEmittedMessages(turn.emittedMessages, message);
  const timelineEventId = `room-message:${message.id}`;
  const timeline = turn.timeline ?? [];
  if (timeline.some((event) => event.id === timelineEventId)) {
    if (nextMessages === turn.emittedMessages) {
      return turn;
    }

    return {
      ...turn,
      emittedMessages: nextMessages,
    };
  }

  return {
    ...turn,
    emittedMessages: nextMessages,
    timeline: [
      ...timeline,
      {
        id: timelineEventId,
        sequence: timeline.length + 1,
        type: "room-message",
        messageId: message.id,
        roomId: message.roomId,
      },
    ],
  };
}
