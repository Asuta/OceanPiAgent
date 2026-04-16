import assert from "node:assert/strict";
import test from "node:test";
import { addAgentParticipantToRoom } from "@/lib/chat/room-actions";
import { createAgentSharedState, createDefaultWorkspaceState, createRoomMessage } from "@/lib/chat/workspace-domain";
import { appendUserRoomMessage, runRoomCommand } from "@/lib/server/room-service";

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
      clearPersistedAgentCompactions: async () => ({
        version: 1 as const,
        agentId: "concierge",
        history: [],
        compactions: [],
        resolvedModel: "",
        compatibility: null,
        updatedAt: new Date().toISOString(),
      }),
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

test("appendUserRoomMessage preserves a caller-provided client message id", async () => {
  const harness = createRoomServiceHarness();
  const roomId = harness.getState().rooms[0]!.id;

  const result = await appendUserRoomMessage(
    {
      roomId,
      content: "Keep this exact id.",
      senderId: "local-operator",
      clientMessageId: "client-message-123",
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  assert.equal(result.userMessage.id, "client-message-123");
  assert.equal(result.room.roomMessages.at(-1)?.id, "client-message-123");
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

test("runRoomCommand clear_room_logs clears room turns and matching agent turns", async () => {
  const harness = createRoomServiceHarness();
  const initialState = harness.getState();
  const primaryRoom = addAgentParticipantToRoom({ room: initialState.rooms[0]!, agentId: "researcher" });
  const otherRoomBase = createDefaultWorkspaceState().rooms[0]!;
  const otherRoom = {
    ...otherRoomBase,
    id: `${otherRoomBase.id}-other`,
    title: "Other room",
  };
  const targetTurn = {
    id: "turn-room",
    agent: { id: "concierge", label: "Harbor Concierge" },
    userMessage: createRoomMessage(primaryRoom.id, "user", "Room log entry", "user"),
    assistantContent: "handled",
    tools: [],
    emittedMessages: [],
    status: "completed" as const,
  };
  const preservedTurn = {
    id: "turn-other",
    agent: { id: "concierge", label: "Harbor Concierge" },
    userMessage: createRoomMessage(otherRoom.id, "user", "Other room entry", "user"),
    assistantContent: "kept",
    tools: [],
    emittedMessages: [],
    status: "completed" as const,
  };

  harness.setState({
    ...initialState,
    rooms: [
      {
        ...primaryRoom,
        agentTurns: [targetTurn],
        error: "Needs cleanup",
      },
      {
        ...otherRoom,
        agentTurns: [preservedTurn],
      },
    ],
    agentStates: {
      ...initialState.agentStates,
      concierge: {
        ...initialState.agentStates.concierge,
        agentTurns: [targetTurn, preservedTurn],
      },
    },
  });

  const result = await runRoomCommand(
    {
      type: "clear_room_logs",
      roomId: primaryRoom.id,
    },
    {
      ...harness.deps,
      enqueueRoomScheduler: async () => {},
      stopRoomScheduler: async () => {},
    },
  );

  assert.deepEqual(result.room?.agentTurns, []);
  assert.equal(result.room?.error, "");
  assert.deepEqual(harness.getState().agentStates.concierge?.agentTurns.map((turn) => turn.id), ["turn-other"]);
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
