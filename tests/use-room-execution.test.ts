import assert from "node:assert/strict";
import test from "node:test";
import { appendMissingMatchingRoomMessages } from "@/components/workspace/use-room-execution";
import type { RoomMessage, RoomSession } from "@/lib/chat/types";

function createRoomMessage(overrides?: Partial<RoomMessage>): RoomMessage {
  return {
    id: "message-1",
    roomId: "room-1",
    seq: 1,
    role: "assistant",
    sender: {
      id: "concierge",
      name: "Harbor Concierge",
      role: "participant",
    },
    content: "Visible reply",
    attachments: [],
    source: "agent_emit",
    kind: "answer",
    status: "completed",
    final: true,
    createdAt: "2026-03-26T00:00:00.000Z",
    receipts: [],
    receiptStatus: "none",
    receiptUpdatedAt: null,
    ...overrides,
  };
}

function createRoom(roomId: string, messages: RoomMessage[] = []): RoomSession {
  return {
    id: roomId,
    title: roomId,
    agentId: "concierge",
    archivedAt: null,
    ownerParticipantId: "local-operator",
    receiptRevision: 0,
    participants: [],
    scheduler: {
      status: "idle",
      nextAgentParticipantId: null,
      activeParticipantId: null,
      roundCount: 0,
      agentCursorByParticipantId: {},
      agentReceiptRevisionByParticipantId: {},
    },
    roomMessages: messages,
    agentTurns: [],
    error: "",
    createdAt: "2026-03-26T00:00:00.000Z",
    updatedAt: "2026-03-26T00:00:00.000Z",
  };
}

test("appendMissingMatchingRoomMessages only appends messages for the target room", () => {
  const localMessage = createRoomMessage({ id: "message-local", roomId: "room-1", content: "local" });
  const remoteMessage = createRoomMessage({ id: "message-remote", roomId: "room-2", content: "remote" });

  const nextRoom = appendMissingMatchingRoomMessages(createRoom("room-1"), [localMessage, remoteMessage]);

  assert.equal(nextRoom.roomMessages.length, 1);
  assert.equal(nextRoom.roomMessages[0]?.id, "message-local");
});

test("appendMissingMatchingRoomMessages updates duplicates already in the room", () => {
  const localMessage = createRoomMessage({ id: "message-local", roomId: "room-1", content: "local", status: "streaming", final: false });
  const completedMessage = createRoomMessage({ id: "message-local", roomId: "room-1", content: "local done", status: "completed", final: true });

  const nextRoom = appendMissingMatchingRoomMessages(createRoom("room-1", [localMessage]), [completedMessage]);

  assert.equal(nextRoom.roomMessages.length, 1);
  assert.equal(nextRoom.roomMessages[0]?.id, "message-local");
  assert.equal(nextRoom.roomMessages[0]?.content, "local done");
  assert.equal(nextRoom.roomMessages[0]?.status, "completed");
});
