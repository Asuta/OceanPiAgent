import assert from "node:assert/strict";
import test from "node:test";
import { addAgentParticipantToRoom } from "@/lib/chat/room-actions";
import { createAgentSharedState, createDefaultWorkspaceState, createRoomMessage } from "@/lib/chat/workspace-domain";
import { runRoomCommand } from "@/lib/server/room-service";

function createRoomServiceHarness() {
  let state = createDefaultWorkspaceState();

  const loadWorkspaceEnvelope = async () => ({
    version: 1,
    updatedAt: new Date().toISOString(),
    state,
  });

  const mutateWorkspace = async (mutator: (workspace: typeof state) => Promise<typeof state> | typeof state) => {
    state = await mutator(state);
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      state,
    };
  };

  return {
    getState: () => state,
    setState: (nextState: typeof state) => {
      state = nextState;
    },
    deps: {
      loadWorkspaceEnvelope,
      mutateWorkspace,
      listAgentDefinitions: async () => [],
    },
  };
}

test("runRoomCommand send_message persists the user message and waits for server scheduling", async () => {
  const harness = createRoomServiceHarness();
  const state = harness.getState();
  state.rooms = [addAgentParticipantToRoom({ room: state.rooms[0]!, agentId: "researcher" })];
  state.agentStates = {
    ...state.agentStates,
    researcher: createAgentSharedState(),
  };
  harness.setState(state);

  const roomId = harness.getState().rooms[0]!.id;
  const queuedRoomIds: string[] = [];

  const result = await runRoomCommand(
    {
      type: "send_message",
      roomId,
      content: "Please sync the room.",
      senderId: "local-operator",
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async (queuedRoomId) => {
        queuedRoomIds.push(queuedRoomId);
        harness.setState({
          ...harness.getState(),
          rooms: harness.getState().rooms.map((room) => {
            if (room.id !== queuedRoomId) {
              return room;
            }

            return {
              ...room,
              roomMessages: [
                ...room.roomMessages,
                createRoomMessage(room.id, "assistant", "Server scheduler finished the handoff.", "agent_emit", {
                  sender: {
                    id: "concierge",
                    name: "Harbor Concierge",
                    role: "participant",
                  },
                }),
              ],
            };
          }),
        });
      },
      stopRoomScheduler: async () => {},
    },
  );

  assert.deepEqual(queuedRoomIds, [roomId]);
  assert.equal(result.room?.roomMessages.some((message) => message.content === "Please sync the room."), true);
  assert.equal(result.room?.roomMessages.some((message) => message.content === "Server scheduler finished the handoff."), true);
});

test("runRoomCommand rename_room trims the title and rejects empty titles", async () => {
  const harness = createRoomServiceHarness();
  const roomId = harness.getState().rooms[0]!.id;

  const result = await runRoomCommand(
    {
      type: "rename_room",
      roomId,
      title: "  Renamed Room  ",
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  assert.equal(result.room?.title, "Renamed Room");

  await assert.rejects(
    () => runRoomCommand(
      {
        type: "rename_room",
        roomId,
        title: "   ",
      },
      {
        ...harness.deps,
        enqueueRoomScheduler: async () => {},
        stopRoomScheduler: async () => {},
      },
    ),
    /Room title cannot be empty\./,
  );
});

test("runRoomCommand archive_room and restore_room toggle archive state", async () => {
  const harness = createRoomServiceHarness();
  const roomId = harness.getState().rooms[0]!.id;

  const archived = await runRoomCommand(
    {
      type: "archive_room",
      roomId,
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );
  assert.ok(archived.room?.archivedAt);

  const restored = await runRoomCommand(
    {
      type: "restore_room",
      roomId,
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );
  assert.equal(restored.room?.archivedAt, null);
});

test("runRoomCommand toggle_room_pinned toggles pinned state", async () => {
  const harness = createRoomServiceHarness();
  const roomId = harness.getState().rooms[0]!.id;

  const pinned = await runRoomCommand(
    {
      type: "toggle_room_pinned",
      roomId,
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );
  assert.ok(pinned.room?.pinnedAt);

  const unpinned = await runRoomCommand(
    {
      type: "toggle_room_pinned",
      roomId,
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );
  assert.equal(unpinned.room?.pinnedAt, null);
});

test("runRoomCommand toggle_room_pinned keeps updatedAt unchanged because pinning is display-only", async () => {
  const harness = createRoomServiceHarness();
  const room = harness.getState().rooms[0]!;
  const fixedUpdatedAt = "2026-01-02T03:04:05.000Z";

  harness.setState({
    ...harness.getState(),
    rooms: harness.getState().rooms.map((entry) => (entry.id === room.id ? { ...entry, updatedAt: fixedUpdatedAt } : entry)),
  });

  const pinned = await runRoomCommand(
    {
      type: "toggle_room_pinned",
      roomId: room.id,
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  assert.ok(pinned.room?.pinnedAt);
  assert.equal(pinned.room?.updatedAt, fixedUpdatedAt);

  const unpinned = await runRoomCommand(
    {
      type: "toggle_room_pinned",
      roomId: room.id,
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  assert.equal(unpinned.room?.pinnedAt, null);
  assert.equal(unpinned.room?.updatedAt, fixedUpdatedAt);
});

test("runRoomCommand create_room returns the new room even when a pinned room still sorts first", async () => {
  const harness = createRoomServiceHarness();
  const pinnedRoomId = harness.getState().rooms[0]!.id;

  await runRoomCommand(
    {
      type: "toggle_room_pinned",
      roomId: pinnedRoomId,
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  const created = await runRoomCommand(
    {
      type: "create_room",
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  assert.ok(created.room);
  assert.notEqual(created.room?.id, pinnedRoomId);
  assert.equal(created.envelope.state.rooms[0]?.id, pinnedRoomId);
  assert.equal(created.room?.title, "Room 2");
});

test("runRoomCommand ensure_world_direct_room creates one fixed direct room per agent and reuses it", async () => {
  const harness = createRoomServiceHarness();

  const created = await runRoomCommand(
    {
      type: "ensure_world_direct_room",
      agentId: "researcher",
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  assert.ok(created.room);
  assert.equal(created.room?.kind, "world_direct");
  assert.equal(created.room?.agentId, "researcher");
  assert.equal(created.room?.participants.length, 2);
  assert.equal(created.room?.participants.filter((participant) => participant.runtimeKind === "human").length, 1);
  assert.equal(created.room?.participants.filter((participant) => participant.runtimeKind === "agent").length, 1);
  assert.ok(created.envelope.state.agentStates.researcher);

  const reused = await runRoomCommand(
    {
      type: "ensure_world_direct_room",
      agentId: "researcher",
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  assert.equal(reused.room?.id, created.room?.id);
  assert.equal(reused.envelope.state.rooms.filter((room) => room.kind === "world_direct" && room.agentId === "researcher").length, 1);
});

test("runRoomCommand world direct rooms reject participant-management mutations", async () => {
  const harness = createRoomServiceHarness();
  const directRoom = await runRoomCommand(
    {
      type: "ensure_world_direct_room",
      agentId: "researcher",
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  const roomId = directRoom.room!.id;

  await assert.rejects(
    () =>
      runRoomCommand(
        {
          type: "add_human_participant",
          roomId,
          name: "Alice",
        },
        {
          ...harness.deps,
          enqueueRoomScheduler: async () => {},
          stopRoomScheduler: async () => {},
        },
      ),
    /locked to a single human and a single agent/i,
  );

  await assert.rejects(
    () =>
      runRoomCommand(
        {
          type: "add_agent_participant",
          roomId,
          agentId: "planner",
        },
        {
          ...harness.deps,
          enqueueRoomScheduler: async () => {},
          stopRoomScheduler: async () => {},
        },
      ),
    /locked to a single human and a single agent/i,
  );

  await assert.rejects(
    () =>
      runRoomCommand(
        {
          type: "remove_participant",
          roomId,
          participantId: "researcher",
        },
        {
          ...harness.deps,
          enqueueRoomScheduler: async () => {},
          stopRoomScheduler: async () => {},
        },
      ),
    /locked to a single human and a single agent/i,
  );
});

test("runRoomCommand clear_room resets transcript, scheduler state, and room errors", async () => {
  const harness = createRoomServiceHarness();
  const state = harness.getState();
  const room = state.rooms[0]!;
  const userMessage = createRoomMessage(room.id, "user", "Please clear this room.", "user", {
    sender: {
      id: "local-operator",
      name: "You",
      role: "participant",
    },
  });

  harness.setState({
    ...state,
    rooms: [
      {
        ...addAgentParticipantToRoom({ room, agentId: "researcher" }),
        roomMessages: [userMessage],
        receiptRevision: 3,
        scheduler: {
          ...room.scheduler,
          status: "idle",
          activeParticipantId: null,
          roundCount: 2,
          agentCursorByParticipantId: { concierge: 1 },
          agentReceiptRevisionByParticipantId: { concierge: 3 },
        },
        error: "Needs reset",
      },
    ],
  });

  const result = await runRoomCommand(
    {
      type: "clear_room",
      roomId: room.id,
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  assert.equal(result.room?.roomMessages.length, 0);
  assert.equal(result.room?.receiptRevision, 0);
  assert.equal(result.room?.scheduler.status, "idle");
  assert.equal(result.room?.scheduler.activeParticipantId, null);
  assert.equal(result.room?.scheduler.roundCount, 0);
  assert.deepEqual(result.room?.scheduler.agentCursorByParticipantId, {});
  assert.deepEqual(result.room?.scheduler.agentReceiptRevisionByParticipantId, {});
  assert.equal(result.room?.error, "");
});

test("runRoomCommand add_agent_participant ensures agent state and supports toggle, move, and remove", async () => {
  const harness = createRoomServiceHarness();
  const roomId = harness.getState().rooms[0]!.id;

  const addedResearcher = await runRoomCommand(
    {
      type: "add_agent_participant",
      roomId,
      agentId: "researcher",
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  assert.equal(addedResearcher.room?.participants.some((participant) => participant.id === "researcher"), true);
  assert.ok(addedResearcher.envelope.state.agentStates.researcher);

  const addedPlanner = await runRoomCommand(
    {
      type: "add_agent_participant",
      roomId,
      agentId: "planner",
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  const planner = addedPlanner.room?.participants.find((participant) => participant.id === "planner");
  const researcher = addedPlanner.room?.participants.find((participant) => participant.id === "researcher");
  assert.ok(planner);
  assert.ok(researcher);
  assert.equal(planner?.enabled, true);
  assert.ok((planner?.order ?? 0) > (researcher?.order ?? 0));

  const toggled = await runRoomCommand(
    {
      type: "toggle_agent_participant",
      roomId,
      participantId: "planner",
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  assert.equal(toggled.room?.participants.find((participant) => participant.id === "planner")?.enabled, false);

  const moved = await runRoomCommand(
    {
      type: "move_agent_participant",
      roomId,
      participantId: "planner",
      direction: -1,
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  const movedPlanner = moved.room?.participants.find((participant) => participant.id === "planner");
  const movedResearcher = moved.room?.participants.find((participant) => participant.id === "researcher");
  assert.ok(movedPlanner);
  assert.ok(movedResearcher);
  assert.ok((movedPlanner?.order ?? 0) < (movedResearcher?.order ?? 0));

  const removed = await runRoomCommand(
    {
      type: "remove_participant",
      roomId,
      participantId: "planner",
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  assert.equal(removed.room?.participants.some((participant) => participant.id === "planner"), false);
  assert.equal(removed.room?.roomMessages.some((message) => message.content.includes("You removed Planner from the room.")), true);
});

test("runRoomCommand add_human_participant trims the name and rejects empty names", async () => {
  const harness = createRoomServiceHarness();
  const roomId = harness.getState().rooms[0]!.id;

  const result = await runRoomCommand(
    {
      type: "add_human_participant",
      roomId,
      name: "  Alice  ",
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  assert.equal(result.room?.participants.some((participant) => participant.runtimeKind === "human" && participant.name === "Alice"), true);
  assert.equal(result.room?.roomMessages.some((message) => message.content.includes("You added Alice to the room.")), true);

  await assert.rejects(
    () => runRoomCommand(
      {
        type: "add_human_participant",
        roomId,
        name: "   ",
      },
      {
        ...harness.deps,
        enqueueRoomScheduler: async () => {},
        stopRoomScheduler: async () => {},
      },
    ),
    /Participant name cannot be empty\./,
  );
});
