import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentOwnedRoomSession,
  createRoomSession,
  reduceRoomManagementActions,
  syncRoomParticipants,
} from "@/lib/chat/workspace-domain";

test("shared room reducer creates rooms and logs the owner action", () => {
  const rooms = [createRoomSession(1)];
  const nextRooms = reduceRoomManagementActions(
    rooms,
    [
      {
        type: "create_room",
        roomId: "room-created-in-test",
        title: "Strategy Room",
        agentIds: ["researcher", "operator"],
      },
    ],
    "researcher",
  );

  const created = nextRooms.find((room) => room.id === "room-created-in-test");
  assert.ok(created);
  assert.equal(created.ownerParticipantId, "researcher");
  assert.equal(created.participants.length, 2);
  assert.match(created.roomMessages[0]?.content ?? "", /created this room/i);
});

test("shared participant sync prunes scheduler state for removed agents", () => {
  const room = createAgentOwnedRoomSession("room-sync-test", "Ops", "concierge", ["concierge", "researcher"]);
  room.scheduler.nextAgentParticipantId = "researcher";
  room.scheduler.activeParticipantId = "researcher";
  room.scheduler.agentCursorByParticipantId = {
    concierge: 3,
    researcher: 7,
  };
  room.scheduler.agentReceiptRevisionByParticipantId = {
    concierge: 1,
    researcher: 2,
  };

  const synced = syncRoomParticipants(
    room,
    room.participants.filter((participant) => participant.id !== "researcher"),
  );

  assert.deepEqual(Object.keys(synced.scheduler.agentCursorByParticipantId), ["concierge"]);
  assert.deepEqual(Object.keys(synced.scheduler.agentReceiptRevisionByParticipantId), ["concierge"]);
  assert.equal(synced.scheduler.activeParticipantId, null);
  assert.equal(synced.scheduler.nextAgentParticipantId, "concierge");
});
