import assert from "node:assert/strict";
import test from "node:test";
import { createSchedulerPacket } from "@/lib/chat/room-scheduler";
import { addAgentParticipantToRoom } from "@/lib/chat/room-actions";
import { appendMessageToRoom, createAgentOwnedRoomSession, createAgentSharedState, createDefaultWorkspaceState, createRoomMessage } from "@/lib/chat/workspace-domain";
import type { RunRoomTurnResult } from "@/lib/server/room-runner";
import { runRoomSchedulerNow, stopRoomScheduler } from "@/lib/server/room-scheduler";

test("createSchedulerPacket includes the full unseen visible delta for the target participant", () => {
  const state = createDefaultWorkspaceState();
  let room = addAgentParticipantToRoom({ room: state.rooms[0]!, agentId: "researcher" });
  const targetParticipant = room.participants.find((participant) => participant.id === "researcher");
  assert.ok(targetParticipant);

  const firstMessage = createRoomMessage(room.id, "assistant", "Concierge already summarized the brief.", "agent_emit", {
    sender: {
      id: "concierge",
      name: "Harbor Concierge",
      role: "participant",
    },
    attachments: [{
      id: "attachment-a",
      kind: "image",
      mimeType: "image/png",
      filename: "brief.png",
      sizeBytes: 1_024,
      storagePath: "workspace/brief.png",
      url: "/brief.png",
    }],
  });
  const secondMessage = createRoomMessage(room.id, "user", "Please also check the numbers in this chart.", "user", {
    sender: {
      id: "local-operator",
      name: "You",
      role: "participant",
    },
    attachments: [{
      id: "attachment-b",
      kind: "image",
      mimeType: "image/png",
      filename: "chart.png",
      sizeBytes: 2_048,
      storagePath: "workspace/chart.png",
      url: "/chart.png",
    }],
  });

  room = appendMessageToRoom(room, firstMessage);
  room = appendMessageToRoom(room, secondMessage);

  const packet = createSchedulerPacket({
    room,
    participant: targetParticipant,
    messages: room.roomMessages,
    requestId: "scheduler-request",
    hasNewDelta: true,
  });

  assert.match(packet.content, /Visible unseen message count: 2/);
  assert.match(packet.content, /Concierge already summarized the brief\./);
  assert.match(packet.content, /Please also check the numbers in this chart\./);
  assert.equal(packet.attachments.length, 2);
  assert.equal(packet.attachments[0]?.id, "attachment-a");
  assert.equal(packet.attachments[1]?.id, "attachment-b");
});

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

test("runRoomSchedulerNow forwards completed emitted room messages for bound-room delivery", async () => {
  let state = createDefaultWorkspaceState();
  let room = appendMessageToRoom(
    state.rooms[0]!,
    createRoomMessage(state.rooms[0]!.id, "user", "Please answer in the bound room.", "user", {
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
  };

  const deliveredBatches: string[][] = [];
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
      const emittedMessages = [
        createRoomMessage(roomId, "assistant", "Bound-room final reply", "agent_emit", {
          sender: {
            id: agentId,
            name: "Harbor Concierge",
            role: "participant",
          },
        }),
      ];

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
          assistantContent: "done",
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
    deliverBoundRoomMessages: async (messages) => {
      deliveredBatches.push(messages.map((message) => message.content));
      return messages.length;
    },
  });

  assert.deepEqual(deliveredBatches, [["Bound-room final reply"]]);
});

test("runRoomSchedulerNow advances past the owner when a new agent-owned room starts with the owner's first message", async () => {
  let state = createDefaultWorkspaceState();
  let room = createAgentOwnedRoomSession(
    "room-owned-by-agent",
    "Owner-led discussion",
    "concierge",
    ["concierge", "researcher", "bridge"],
  );
  room = appendMessageToRoom(
    room,
    createRoomMessage(room.id, "assistant", "Please discuss who has the stronger legacy.", "agent_emit", {
      sender: {
        id: "concierge",
        name: "Harbor Concierge",
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
      bridge: createAgentSharedState(),
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
      const emittedMessages = agentId === "researcher"
        ? [
            createRoomMessage(roomId, "assistant", "Researcher picks Chow for auteur impact.", "agent_emit", {
              sender: {
                id: "researcher",
                name: "Signal Researcher",
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
          assistantContent: `${agentId} complete`,
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
  assert.deepEqual(callOrder, ["researcher", "bridge", "concierge"]);
  assert.equal(nextRoom.scheduler.status, "idle");
  assert.equal(nextRoom.roomMessages.some((message) => message.content === "Researcher picks Chow for auteur impact."), true);
});

test("stopRoomScheduler forces a running room back to idle and marks running turns stopped", async () => {
  let state = createDefaultWorkspaceState();
  const room = state.rooms[0]!;
  const runningTurn = {
    id: "stream:running-turn",
    agent: {
      id: "concierge",
      label: "Harbor Concierge",
    },
    userMessage: createRoomMessage(room.id, "system", "Scheduler packet", "system", {
      sender: {
        id: "room-scheduler",
        name: "Room Scheduler",
        role: "system",
      },
      kind: "system",
    }),
    assistantContent: "",
    tools: [],
    emittedMessages: [],
    status: "running" as const,
  };
  state = {
    ...state,
    rooms: [{
      ...room,
      scheduler: {
        ...room.scheduler,
        status: "running",
        activeParticipantId: room.participants.find((participant) => participant.runtimeKind === "agent")?.id ?? null,
      },
      agentTurns: [runningTurn],
    }],
    agentStates: {
      ...state.agentStates,
      concierge: {
        ...state.agentStates.concierge,
        agentTurns: [runningTurn],
      },
    },
  };
  const mutateWorkspace = async (mutator: (workspace: typeof state) => Promise<typeof state> | typeof state) => {
    state = await mutator(state);
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      state,
    };
  };

  await stopRoomScheduler(room.id, "Stopped for testing.", {
    mutateWorkspace,
  });

  const nextRoom = state.rooms[0]!;
  assert.equal(nextRoom.scheduler.status, "idle");
  assert.equal(nextRoom.scheduler.activeParticipantId, null);
  assert.equal(nextRoom.agentTurns[0]?.status, "error");
  assert.equal(state.agentStates.concierge.agentTurns[0]?.error, "Stopped for testing.");
});
