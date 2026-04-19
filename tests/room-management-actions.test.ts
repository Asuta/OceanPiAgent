import assert from "node:assert/strict";
import test from "node:test";
import { applyRoomManagementActionsToRooms } from "@/components/workspace/room-management-actions";
import { createRoomSession } from "@/lib/chat/workspace-domain";

test("applyRoomManagementActionsToRooms immediately inserts newly created rooms", () => {
  const existingRoom = createRoomSession(1, "concierge");
  const nextRooms = applyRoomManagementActionsToRooms({
    rooms: [existingRoom],
    actions: [
      {
        type: "create_room",
        roomId: "room-new",
        title: "Fresh Room",
        agentIds: ["concierge", "bridge-operator"],
      },
    ],
    actorAgentId: "concierge",
  });

  const createdRoom = nextRooms.find((room) => room.id === "room-new");
  assert.ok(createdRoom);
  assert.equal(createdRoom?.title, "Fresh Room");
  assert.equal(createdRoom?.participants.some((participant) => participant.agentId === "bridge-operator"), true);
});

test("applyRoomManagementActionsToRooms keeps create_room idempotent for duplicate actions", () => {
  const existingRoom = createRoomSession(1, "concierge");
  const once = applyRoomManagementActionsToRooms({
    rooms: [existingRoom],
    actions: [
      {
        type: "create_room",
        roomId: "room-new",
        title: "Fresh Room",
        agentIds: ["concierge"],
      },
    ],
    actorAgentId: "concierge",
  });

  const twice = applyRoomManagementActionsToRooms({
    rooms: once,
    actions: [
      {
        type: "create_room",
        roomId: "room-new",
        title: "Fresh Room",
        agentIds: ["concierge"],
      },
    ],
    actorAgentId: "concierge",
  });

  assert.equal(twice.filter((room) => room.id === "room-new").length, 1);
});
