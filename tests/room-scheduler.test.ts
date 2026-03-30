import assert from "node:assert/strict";
import test from "node:test";
import { addAgentParticipantToRoom } from "@/lib/chat/room-actions";
import { appendMessageToRoom, createAgentSharedState, createDefaultWorkspaceState, createRoomMessage } from "@/lib/chat/workspace-domain";
import type { RunRoomTurnResult } from "@/lib/server/room-runner";
import { runRoomSchedulerNow } from "@/lib/server/room-scheduler";

test("runRoomSchedulerNow advances multi-agent room work on the server and settles idle", async () => {
  let state = createDefaultWorkspaceState();
  let room = addAgentParticipantToRoom({ room: state.rooms[0]!, agentId: "researcher" });
  const inboundMessage = createRoomMessage(room.id, "user", "Team, please coordinate.", "user", {
    sender: {
      id: "local-operator",
      name: "You",
      role: "participant",
    },
  });
  room = appendMessageToRoom(room, inboundMessage);
  state = {
    ...state,
    rooms: [room],
    agentStates: {
      ...state.agentStates,
      researcher: createAgentSharedState(),
    },
  };

  const callOrder: string[] = [];
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

  await runRoomSchedulerNow(room.id, {
    loadWorkspaceEnvelope,
    mutateWorkspace,
    runRoomTurnNonStreaming: async ({ roomId, message, agentId }) => {
      callOrder.push(agentId);
      const emittedMessages = agentId === "concierge"
        ? [
            createRoomMessage(roomId, "assistant", "Concierge handed this to Researcher.", "agent_emit", {
              sender: {
                id: "concierge",
                name: "Harbor Concierge",
                role: "participant",
              },
            }),
          ]
        : [];

      const result: RunRoomTurnResult = {
        turn: {
          id: `turn-${agentId}`,
          agent: {
            id: agentId,
            label: agentId,
          },
          userMessage: {
            ...createRoomMessage(roomId, "system", message.content, "system", {
              sender: message.sender,
              kind: "system",
            }),
            id: message.id,
          },
          assistantContent: agentId === "concierge" ? "Passing this along." : "Research complete.",
          tools: [],
          emittedMessages,
          status: "completed",
          resolvedModel: "generic/fake-model",
        },
        resolvedModel: "generic/fake-model",
        compatibility: {
          providerKey: "generic",
          providerLabel: "Generic",
          baseUrl: "",
          chatCompletionsToolStyle: "tools",
          responsesContinuation: "replay",
          responsesPayloadMode: "json",
          notes: [],
        },
        emittedMessages,
        receiptUpdates: [],
        roomActions: [],
      };

      return result;
    },
  });

  const nextRoom = state.rooms[0]!;
  assert.deepEqual(callOrder, ["concierge", "researcher"]);
  assert.equal(nextRoom.scheduler.status, "idle");
  assert.equal(nextRoom.roomMessages.some((message) => message.content === "Concierge handed this to Researcher."), true);
  assert.equal(nextRoom.agentTurns.length, 2);
});

test("runRoomSchedulerNow emits streaming callbacks for each scheduled turn", async () => {
  let state = createDefaultWorkspaceState();
  let room = addAgentParticipantToRoom({ room: state.rooms[0]!, agentId: "researcher" });
  room = appendMessageToRoom(
    room,
    createRoomMessage(room.id, "user", "Please keep coordinating until idle.", "user", {
      sender: {
        id: "local-operator",
        name: "You",
        role: "participant",
      },
    }),
  );
  state = {
    ...state,
    rooms: [room],
    agentStates: {
      ...state.agentStates,
      researcher: createAgentSharedState(),
    },
  };

  const streamedTurns: string[] = [];
  const streamedDeltas: string[] = [];
  const streamedDone: string[] = [];
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

  await runRoomSchedulerNow(room.id, {
    loadWorkspaceEnvelope,
    mutateWorkspace,
    resolveSettingsWithModelConfig: async (settings) => ({
      settings,
      modelConfig: null,
      modelConfigOverrides: undefined,
    }),
    buildPreparedInputFromWorkspace: async ({ roomId, agentId, message, settings, anchorMessageId, turnId }) => ({
      room: {
        id: roomId,
        title: "Room 1",
      },
      agent: {
        id: agentId,
        label: agentId,
        instruction: "",
      },
      attachedRooms: [],
      knownAgents: [],
      roomHistoryById: {},
      message,
      settings,
      anchorMessageId,
      turnId,
    }),
    runPreparedRoomTurn: async (preparedInput, callbacks) => {
      callbacks?.onTextDelta?.(`${preparedInput.agent.id}-draft`);
      const emittedMessages = preparedInput.agent.id === "concierge"
        ? [
            createRoomMessage(preparedInput.room.id, "assistant", "Concierge handed this to Researcher.", "agent_emit", {
              sender: {
                id: "concierge",
                name: "Harbor Concierge",
                role: "participant",
              },
            }),
          ]
        : [];

      return {
        turn: {
          id: preparedInput.turnId ?? `turn-${preparedInput.agent.id}`,
          agent: {
            id: preparedInput.agent.id,
            label: preparedInput.agent.label,
          },
          userMessage: {
            ...createRoomMessage(preparedInput.room.id, "system", preparedInput.message.content, "system", {
              sender: preparedInput.message.sender,
              kind: "system",
            }),
            id: preparedInput.message.id,
          },
          assistantContent: `${preparedInput.agent.id}-draft`,
          draftSegments: [
            {
              id: `${preparedInput.agent.id}-segment`,
              sequence: 1,
              content: `${preparedInput.agent.id}-draft`,
              status: "completed",
            },
          ],
          timeline: [
            {
              id: `draft-segment:${preparedInput.agent.id}-segment`,
              sequence: 1,
              type: "draft-segment",
              segmentId: `${preparedInput.agent.id}-segment`,
            },
          ],
          tools: [],
          emittedMessages,
          status: "completed",
          resolvedModel: "generic/fake-model",
        },
        resolvedModel: "generic/fake-model",
        compatibility: {
          providerKey: "generic",
          providerLabel: "Generic",
          baseUrl: "",
          chatCompletionsToolStyle: "tools",
          responsesContinuation: "replay",
          responsesPayloadMode: "json",
          notes: [],
        },
        emittedMessages,
        receiptUpdates: [],
        roomActions: [],
      };
    },
    onTurnStart: (turn) => {
      streamedTurns.push(turn.agent.id);
    },
    onTextDelta: (delta) => {
      streamedDeltas.push(delta);
    },
    onTurnDone: (result) => {
      streamedDone.push(result.turn.agent.id);
    },
  });

  assert.deepEqual(streamedTurns, ["concierge", "researcher"]);
  assert.deepEqual(streamedDeltas, ["concierge-draft", "researcher-draft"]);
  assert.deepEqual(streamedDone, ["concierge", "researcher"]);
});
