import assert from "node:assert/strict";
import test from "node:test";
import { createAgentSharedState, createDefaultWorkspaceState, createRoomMessage } from "@/lib/chat/workspace-domain";
import { applyWorkspaceStatePatch, createWorkspaceStatePatch } from "@/lib/chat/workspace-stream";

test("createWorkspaceStatePatch only includes changed room and agent state entries", () => {
  const previous = createDefaultWorkspaceState();
  const addedAgentId = "analyst" as const;
  const changedRoom = {
    ...previous.rooms[0]!,
    roomMessages: [
      ...previous.rooms[0]!.roomMessages,
      createRoomMessage(previous.rooms[0]!.id, "assistant", "Updated", "agent_emit"),
    ],
  };
  const next = {
    ...previous,
    rooms: [changedRoom],
    agentStates: {
      ...previous.agentStates,
      concierge: {
        ...previous.agentStates.concierge,
        resolvedModel: "generic/test-model",
      },
      [addedAgentId]: createAgentSharedState(),
    },
  };

  const patch = createWorkspaceStatePatch(previous, next);

  assert.equal(patch.rooms, undefined);
  assert.equal(patch.roomPatches?.length, 1);
  assert.equal(patch.roomPatches?.[0]?.roomId, changedRoom.id);
  assert.equal(patch.roomPatches?.[0]?.messageUpserts?.length, 1);
  assert.equal(patch.agentStates?.[addedAgentId]?.updatedAt !== undefined, true);
  assert.equal(patch.agentStatePatches?.[0]?.agentId, "concierge");
  assert.equal(patch.agentStatePatches?.[0]?.resolvedModel, "generic/test-model");
});

test("applyWorkspaceStatePatch merges additions and removals into the current workspace", () => {
  const previous = createDefaultWorkspaceState();
  const addedRoom = {
    ...previous.rooms[0]!,
    id: "room-2",
    title: "Room 2",
  };
  const patch = {
    rooms: [addedRoom],
    removedRoomIds: [previous.rooms[0]!.id],
    agentStates: {
      researcher: createAgentSharedState(),
    },
    removedAgentIds: ["concierge" as const],
    activeRoomId: "room-2",
    selectedConsoleAgentId: "researcher" as const,
  };

  const next = applyWorkspaceStatePatch(previous, patch);

  assert.deepEqual(next.rooms.map((room) => room.id), ["room-2"]);
  assert.equal(next.agentStates.concierge, undefined);
  assert.ok(next.agentStates.researcher);
  assert.equal(next.activeRoomId, "room-2");
  assert.equal(next.selectedConsoleAgentId, "researcher");
});
