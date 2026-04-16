import assert from "node:assert/strict";
import test from "node:test";
import { createSchedulerPacket } from "@/lib/chat/room-scheduler";
import { addAgentParticipantToRoom } from "@/lib/chat/room-actions";
import { appendMessageToRoom, createAgentOwnedRoomSession, createAgentSharedState, createDefaultWorkspaceState, createRoomMessage } from "@/lib/chat/workspace-domain";
import { runPreparedRoomTurn as executePreparedRoomTurn, type RunRoomTurnResult } from "@/lib/server/room-runner";
import {
  enqueueRoomScheduler,
  getRoomSchedulerQueueSnapshotForTest,
  resetRoomSchedulerStateForTest,
  runRoomSchedulerNow,
  stopRoomScheduler,
} from "@/lib/server/room-scheduler";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("createSchedulerPacket includes a compact unseen visible delta for the target participant", () => {
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

  assert.equal(
    packet.content,
    [
      "[Room scheduler sync packet]",
      `Latest messageId: ${secondMessage.id}`,
      "Unseen messages:",
      "- Harbor Concierge: Concierge already summarized the brief. [Image: brief.png, 0.00 MB]",
      "- You: Please also check the numbers in this chart. [Image: chart.png, 0.00 MB]",
    ].join("\n"),
  );
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

test("runRoomSchedulerNow stops after each enabled agent answers the same human message once", async () => {
  let state = createDefaultWorkspaceState();
  let room = addAgentParticipantToRoom({ room: state.rooms[0]!, agentId: "researcher" });
  room = addAgentParticipantToRoom({ room, agentId: "operator" });
  const inboundMessage = createRoomMessage(room.id, "user", "Give one take each, then stop.", "user", {
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
      operator: createAgentSharedState(),
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
    runRoomTurnNonStreaming: async ({ roomId, agentId, message }) => {
      callOrder.push(agentId);
      const emittedMessages = [
        createRoomMessage(roomId, "assistant", `${agentId} replied to ${message.id}.`, "agent_emit", {
          sender: {
            id: agentId,
            name: agentId,
            role: "participant",
          },
        }),
      ];

      return {
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
          assistantContent: `${agentId} done`,
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
      } satisfies RunRoomTurnResult;
    },
  });

  assert.deepEqual(callOrder, ["concierge", "researcher", "operator"]);
  assert.equal(state.rooms[0]?.scheduler.status, "idle");
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
  const streamedDone: Array<{ agentId: string; roomRunning: boolean }> = [];
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
    onTurnDone: (result, roomRunning) => {
      streamedDone.push({ agentId: result.turn.agent.id, roomRunning });
    },
  });

  assert.deepEqual(streamedTurns, ["concierge", "researcher"]);
  assert.deepEqual(streamedDeltas, ["concierge-draft", "researcher-draft"]);
  assert.deepEqual(streamedDone, [
    { agentId: "concierge", roomRunning: true },
    { agentId: "researcher", roomRunning: false },
  ]);
});

test("runRoomSchedulerNow settles idle after a streaming room turn fails with partial tool output", async () => {
  let state = createDefaultWorkspaceState();
  const room = appendMessageToRoom(
    state.rooms[0]!,
    createRoomMessage(state.rooms[0]!.id, "user", "Please acknowledge this and continue.", "user", {
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

  const streamedDone: Array<{ status: string; roomRunning: boolean }> = [];
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
    buildPreparedInputFromWorkspace: async ({ roomId, agentId, message, settings, anchorMessageId, turnId, signal }) => ({
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
      signal,
    }),
    runPreparedRoomTurn: async (preparedInput, callbacks) => executePreparedRoomTurn(
      {
        ...preparedInput,
        conversationRunner: async (_messages, _settings, innerCallbacks) => {
          innerCallbacks?.onTool?.({
            id: "tool-1",
            sequence: 1,
            toolName: "send_message_to_room",
            displayName: "Send Message To Room",
            inputSummary: "send",
            inputText: "{}",
            resultPreview: "sent",
            outputText: "sent",
            status: "success",
            durationMs: 1,
            roomMessage: {
              roomId: preparedInput.room.id,
              content: "Visible progress update",
              kind: "progress",
              status: "completed",
              final: false,
            },
          });
          throw new Error("Model stalled for 20000 ms after completing tool Send Message To Room.");
        },
      },
      callbacks,
    ),
    onTurnDone: (result, roomRunning) => {
      streamedDone.push({ status: result.turn.status, roomRunning });
    },
  });

  const nextRoom = state.rooms[0]!;
  const latestTurn = nextRoom.agentTurns.at(-1);
  assert.equal(nextRoom.scheduler.status, "idle");
  assert.equal(latestTurn?.status, "error");
  assert.match(latestTurn?.error ?? "", /Model stalled for 20000 ms after completing tool Send Message To Room\./);
  assert.equal(nextRoom.roomMessages.some((message) => message.content === "Visible progress update"), true);
  assert.deepEqual(streamedDone, [{ status: "error", roomRunning: false }]);
});

test("runRoomSchedulerNow no longer applies the legacy scheduler turn timeout", async () => {
  const previousTimeout = process.env.OCEANKING_ROOM_SCHEDULER_TURN_TIMEOUT_MS;
  process.env.OCEANKING_ROOM_SCHEDULER_TURN_TIMEOUT_MS = "20";

  try {
    let state = createDefaultWorkspaceState();
    let room = addAgentParticipantToRoom({ room: state.rooms[0]!, agentId: "researcher" });
    room = appendMessageToRoom(
      room,
      createRoomMessage(state.rooms[0]!.id, "user", "Please continue until timeout.", "user", {
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
    const streamedErrors: string[] = [];
    const streamedDone: Array<{ status: string; roomRunning: boolean }> = [];

    await runRoomSchedulerNow(room.id, {
      loadWorkspaceEnvelope,
      mutateWorkspace,
      resolveSettingsWithModelConfig: async (settings) => ({
        settings,
        modelConfig: null,
        modelConfigOverrides: undefined,
      }),
      buildPreparedInputFromWorkspace: async ({ roomId, agentId, message, settings, anchorMessageId, turnId, signal }) => ({
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
        signal,
      }),
      runPreparedRoomTurn: async (preparedInput) => {
        await new Promise((resolve) => {
          setTimeout(resolve, 40);
        });
        return {
          turn: {
            id: preparedInput.turnId ?? "turn-researcher",
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
            assistantContent: "Completed after waiting longer than the legacy timeout.",
            draftSegments: [],
            timeline: [],
            tools: [],
            emittedMessages: [],
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
          emittedMessages: [],
          receiptUpdates: [],
          roomActions: [],
        };
      },
      onError: (error) => {
        streamedErrors.push(error instanceof Error ? error.message : String(error));
      },
      onTurnDone: (result, roomRunning) => {
        streamedDone.push({ status: result.turn.status, roomRunning });
      },
    });

    assert.equal(state.rooms[0]?.scheduler.status, "idle");
    assert.equal(state.rooms[0]?.error ?? "", "");
    assert.deepEqual(streamedErrors, []);
    assert.deepEqual(streamedDone, [
      { status: "completed", roomRunning: true },
      { status: "completed", roomRunning: false },
    ]);
    assert.equal(state.rooms[0]?.agentTurns.at(-1)?.status, "completed");
  } finally {
    if (typeof previousTimeout === "string") {
      process.env.OCEANKING_ROOM_SCHEDULER_TURN_TIMEOUT_MS = previousTimeout;
    } else {
      delete process.env.OCEANKING_ROOM_SCHEDULER_TURN_TIMEOUT_MS;
    }
  }
});

test("runRoomSchedulerNow forwards completed emitted room messages for bound-room delivery", async () => {
  let state = createDefaultWorkspaceState();
  const room = appendMessageToRoom(
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

test("runRoomSchedulerNow resolves model config overrides for non-streaming turns", async () => {
  let state = createDefaultWorkspaceState();
  const room = appendMessageToRoom(
    state.rooms[0]!,
    createRoomMessage(state.rooms[0]!.id, "user", "Please use the configured endpoint.", "user", {
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

  let forwardedSettingsModel = "";
  let forwardedBaseUrl = "";
  let forwardedApiKey = "";

  await runRoomSchedulerNow(room.id, {
    loadWorkspaceEnvelope,
    mutateWorkspace,
    resolveSettingsWithModelConfig: async (settings) => ({
      settings: {
        ...settings,
        model: "deepseek-chat",
      },
      modelConfig: null,
      modelConfigOverrides: {
        baseUrl: "https://api.deepseek.com",
        apiKey: "deepseek-key",
      },
    }),
    runRoomTurnNonStreaming: async ({ roomId, message, agentId, settings, modelConfigOverrides }) => {
      forwardedSettingsModel = settings.model;
      forwardedBaseUrl = modelConfigOverrides?.baseUrl ?? "";
      forwardedApiKey = modelConfigOverrides?.apiKey ?? "";

      return {
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
          emittedMessages: [],
          status: "completed",
          resolvedModel: "deepseek-chat",
        },
        resolvedModel: "deepseek-chat",
        compatibility: {
          providerKey: "generic",
          providerLabel: "Generic",
          baseUrl: "https://api.deepseek.com",
          chatCompletionsToolStyle: "tools",
          responsesContinuation: "replay",
          responsesPayloadMode: "json",
          notes: [],
        },
        emittedMessages: [],
        receiptUpdates: [],
        roomActions: [],
      };
    },
  });

  assert.equal(forwardedSettingsModel, "deepseek-chat");
  assert.equal(forwardedBaseUrl, "https://api.deepseek.com");
  assert.equal(forwardedApiKey, "deepseek-key");
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
  const streamingAgentTurn = {
    ...runningTurn,
    draftSegments: [{
      id: "draft-1",
      sequence: 1,
      content: "Still streaming",
      status: "streaming" as const,
    }],
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

  const nextRoom = state.rooms.find((entry) => entry.id === room.id);
  assert.ok(nextRoom);
  const nextRoomTurn = nextRoom.agentTurns.find((turn) => turn.id === runningTurn.id);
  assert.ok(nextRoomTurn);
  const nextAgentTurn = state.agentStates.concierge.agentTurns.find((turn) => turn.id === streamingAgentTurn.id);
  assert.ok(nextAgentTurn);
  assert.equal(nextRoom.scheduler.status, "idle");
  assert.equal(nextRoom.scheduler.activeParticipantId, null);
  assert.equal(nextRoomTurn.status, "error");
  assert.equal(nextAgentTurn.error, "Stopped for testing.");
});

test("stopRoomScheduler also stops running agent-state turns that have not been persisted to the room yet", async () => {
  let state = createDefaultWorkspaceState();
  const room = state.rooms[0]!;
  const runningTurn = {
    id: "stream:agent-state-only-running-turn",
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
    draftSegments: [{
      id: "draft-1",
      sequence: 1,
      content: "Still streaming",
      status: "streaming" as const,
    }],
    status: "running" as const,
  };
  const streamingAgentTurn = {
    ...runningTurn,
    draftSegments: [{
      id: "draft-1",
      sequence: 1,
      content: "Still streaming",
      status: "streaming" as const,
    }],
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
      agentTurns: [],
    }],
    agentStates: {
      ...state.agentStates,
      concierge: {
        ...state.agentStates.concierge,
        agentTurns: [streamingAgentTurn],
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
  assert.equal(nextRoom.agentTurns.length, 0);
  assert.equal(state.agentStates.concierge.agentTurns[0]?.status, "error");
  assert.equal(state.agentStates.concierge.agentTurns[0]?.error, "Stopped for testing.");
  assert.equal(state.agentStates.concierge.agentTurns[0]?.draftSegments?.[0]?.status, "completed");
});

test("enqueueRoomScheduler merges queued overrides with the active run overrides", async () => {
  await resetRoomSchedulerStateForTest();

  let state = createDefaultWorkspaceState();
  const room = appendMessageToRoom(
    state.rooms[0]!,
    createRoomMessage(state.rooms[0]!.id, "user", "Please handle the first message.", "user", {
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

  const firstTurnEntered = createDeferred<void>();
  const releaseFirstTurn = createDeferred<void>();
  let runCount = 0;
  const roomId = room.id;

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

  const runRoomTurnNonStreamingOverride = async ({ roomId: targetRoomId, message, agentId }: {
    roomId: string;
    message: { id: string; content: string; sender: { id: string; name: string; role: "participant" | "system" } };
    agentId: string;
  }) => {
    runCount += 1;
    if (runCount === 1) {
      firstTurnEntered.resolve();
      await releaseFirstTurn.promise;
    }
    const result: RunRoomTurnResult = {
      turn: {
        id: "turn-1",
        agent: {
          id: agentId,
          label: agentId,
        },
        userMessage: {
          ...createRoomMessage(targetRoomId, "system", message.content, "system", {
            sender: message.sender,
            kind: "system",
          }),
          id: message.id,
        },
        assistantContent: `${agentId}-done`,
        tools: [],
        emittedMessages: [],
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
      emittedMessages: [],
      receiptUpdates: [],
      roomActions: [],
    };

    return result;
  };

  const schedulerPromise = enqueueRoomScheduler(roomId, {
    loadWorkspaceEnvelope,
    mutateWorkspace,
    runRoomTurnNonStreaming: runRoomTurnNonStreamingOverride,
  });

  await firstTurnEntered.promise;

  const deliverBoundRoomMessages = async (messages: Awaited<RunRoomTurnResult>["emittedMessages"]) => messages.length;
  const queuedPromise = enqueueRoomScheduler(roomId, {
    deliverBoundRoomMessages,
  });

  const queueSnapshot = getRoomSchedulerQueueSnapshotForTest(roomId);
  assert.ok(queueSnapshot);
  assert.equal(queueSnapshot?.running, true);
  assert.equal(queueSnapshot?.rerun, true);

  const activeOverrides = queueSnapshot?.activeOverrides;
  const queuedOverrides = queueSnapshot?.queuedOverrides;
  assert.ok(activeOverrides);
  assert.ok(queuedOverrides);
  assert.equal(queuedOverrides?.loadWorkspaceEnvelope, activeOverrides?.loadWorkspaceEnvelope);
  assert.equal(queuedOverrides?.mutateWorkspace, activeOverrides?.mutateWorkspace);
  assert.equal(activeOverrides?.runRoomTurnNonStreaming, runRoomTurnNonStreamingOverride);
  assert.equal(queuedOverrides?.runRoomTurnNonStreaming, runRoomTurnNonStreamingOverride);
  assert.equal(queuedOverrides?.deliverBoundRoomMessages, deliverBoundRoomMessages);

  releaseFirstTurn.resolve();
  await Promise.all([schedulerPromise, queuedPromise]);

  assert.equal(runCount, 1);

  await resetRoomSchedulerStateForTest();
});
