import assert from "node:assert/strict";
import test from "node:test";
import { buildRoomThreadDraftEntries, buildRoomThreadToolEntries } from "@/components/workspace/room-thread";
import type { AgentRoomTurn, AgentSharedState, RoomMessage, ToolExecution, TurnTimelineEvent } from "@/lib/chat/types";

function createTool(id: string, sequence = 1): ToolExecution {
  return {
    id,
    sequence,
    toolName: "bash",
    displayName: `Bash ${id}`,
    inputSummary: "run",
    inputText: "pwd",
    resultPreview: "ok",
    outputText: "/workspace",
    status: "success",
    durationMs: 10,
  };
}

function createMessage(overrides?: Partial<RoomMessage>): RoomMessage {
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
    createdAt: "2026-03-28T10:00:00.000Z",
    receipts: [],
    receiptStatus: "none",
    receiptUpdatedAt: null,
    ...overrides,
  };
}

function createTurn(overrides?: Partial<AgentRoomTurn>): AgentRoomTurn {
  const answerMessage = createMessage({ id: "answer-1", seq: 2, createdAt: "2026-03-28T10:00:00.000Z" });
  const tool = createTool("tool-1", 1);
  const timeline: TurnTimelineEvent[] = [
    {
      id: `tool:${tool.id}`,
      sequence: 1,
      type: "tool",
      toolId: tool.id,
    },
    {
      id: `room-message:${answerMessage.id}`,
      sequence: 2,
      type: "room-message",
      messageId: answerMessage.id,
      roomId: answerMessage.roomId,
    },
  ];

  return {
    id: "turn-1",
    agent: {
      id: "concierge",
      label: "Harbor Concierge",
    },
    userMessage: createMessage({
      id: "user-1",
      seq: 1,
      role: "user",
      sender: {
        id: "local-user",
        name: "You",
        role: "participant",
      },
      source: "user",
      kind: "user_input",
      content: "Please investigate",
      createdAt: "2026-03-28T09:59:00.000Z",
    }),
    assistantContent: "Investigating",
    timeline,
    tools: [tool],
    emittedMessages: [answerMessage],
    status: "completed",
    ...overrides,
  };
}

function createAgentState(turns: AgentRoomTurn[]): AgentSharedState {
  return {
    settings: {
      modelConfigId: null,
      apiFormat: "chat_completions",
      model: "gpt-5.4",
      systemPrompt: "",
      providerMode: "auto",
      memoryBackend: "sqlite-fts",
      compactionTokenThreshold: 200_000,
      maxToolLoopSteps: 8,
      thinkingLevel: "off",
      enabledSkillIds: [],
    },
    agentTurns: turns,
    resolvedModel: "gpt-5.4",
    compatibility: null,
    updatedAt: "2026-03-28T10:00:00.000Z",
  };
}

test("places tool events after the user message when the tool happens before the visible reply", () => {
  const turn = createTurn();
  const entries = buildRoomThreadToolEntries({
    roomId: "room-1",
    roomMessages: [turn.userMessage, turn.emittedMessages[0]!],
    agentStates: {
      concierge: createAgentState([turn]),
    },
  });

  assert.equal(entries.get("user-1")?.length, 1);
  assert.equal(entries.has("answer-1"), false);
  assert.equal(entries.get("user-1")?.[0]?.tool.id, "tool-1");
});

test("moves later tool events under the emitted message that happened before them", () => {
  const firstTool = createTool("tool-1", 1);
  const secondTool = createTool("tool-2", 2);
  const answerMessage = createMessage({ id: "answer-1", seq: 2 });
  const turn = createTurn({
    tools: [firstTool, secondTool],
    emittedMessages: [answerMessage],
    timeline: [
      { id: `tool:${firstTool.id}`, sequence: 1, type: "tool", toolId: firstTool.id },
      { id: `room-message:${answerMessage.id}`, sequence: 2, type: "room-message", messageId: answerMessage.id, roomId: answerMessage.roomId },
      { id: `tool:${secondTool.id}`, sequence: 3, type: "tool", toolId: secondTool.id },
    ],
  });

  const entries = buildRoomThreadToolEntries({
    roomId: "room-1",
    roomMessages: [turn.userMessage, answerMessage],
    agentStates: {
      concierge: createAgentState([turn]),
    },
  });

  assert.equal(entries.get("user-1")?.[0]?.tool.id, "tool-1");
  assert.equal(entries.get("answer-1")?.[0]?.tool.id, "tool-2");
});

test("collects tool events from multiple agents in the same room", () => {
  const firstTurn = createTurn();
  const secondAnswer = createMessage({ id: "answer-2", seq: 4, createdAt: "2026-03-28T10:02:00.000Z" });
  const secondTool = createTool("tool-2", 1);
  const secondTurn = createTurn({
    id: "turn-2",
    agent: {
      id: "navigator",
      label: "Harbor Navigator",
    },
    userMessage: createMessage({
      id: "user-2",
      seq: 3,
      role: "user",
      sender: {
        id: "local-user",
        name: "You",
        role: "participant",
      },
      source: "user",
      kind: "user_input",
      content: "Please continue",
      createdAt: "2026-03-28T10:01:00.000Z",
    }),
    tools: [secondTool],
    emittedMessages: [secondAnswer],
    timeline: [
      { id: `tool:${secondTool.id}`, sequence: 1, type: "tool", toolId: secondTool.id },
      { id: `room-message:${secondAnswer.id}`, sequence: 2, type: "room-message", messageId: secondAnswer.id, roomId: secondAnswer.roomId },
    ],
  });

  const entries = buildRoomThreadToolEntries({
    roomId: "room-1",
    roomMessages: [firstTurn.userMessage, firstTurn.emittedMessages[0]!, secondTurn.userMessage, secondAnswer],
    agentStates: {
      concierge: createAgentState([firstTurn]),
      navigator: createAgentState([secondTurn]),
    },
  });

  assert.equal(entries.get("user-1")?.[0]?.turn.agent.id, "concierge");
  assert.equal(entries.get("user-2")?.[0]?.turn.agent.id, "navigator");
});

test("falls back to tool-before-message ordering when legacy turns have no timeline", () => {
  const firstTool = createTool("tool-1", 1);
  const secondTool = createTool("tool-2", 2);
  const answerMessage = createMessage({ id: "answer-1", seq: 2 });
  const turn = createTurn({
    timeline: undefined,
    tools: [firstTool, secondTool],
    emittedMessages: [answerMessage],
  });

  const entries = buildRoomThreadToolEntries({
    roomId: "room-1",
    roomMessages: [turn.userMessage, answerMessage],
    agentStates: {
      concierge: createAgentState([turn]),
    },
  });

  assert.deepEqual(
    entries.get("user-1")?.map((entry) => entry.tool.id),
    ["tool-1", "tool-2"],
  );
});

test("ignores tool events when their anchor message is not visible in the current room", () => {
  const remoteAnswer = createMessage({ id: "remote-answer", roomId: "room-2", seq: 1 });
  const turn = createTurn({
    emittedMessages: [remoteAnswer],
    timeline: [
      { id: "room-message:remote-answer", sequence: 1, type: "room-message", messageId: remoteAnswer.id, roomId: remoteAnswer.roomId },
    ],
    tools: [],
  });

  const entries = buildRoomThreadToolEntries({
    roomId: "room-1",
    roomMessages: [turn.userMessage],
    agentStates: {
      concierge: createAgentState([turn]),
    },
  });

  assert.equal(entries.size, 0);
});

test("falls back to scheduler packet latest message id for legacy turns", () => {
  const tool = createTool("tool-1", 1);
  const turn = createTurn({
    userMessage: createMessage({
      id: "scheduler-1",
      roomId: "room-1",
      seq: 0,
      role: "system",
      sender: {
        id: "room-scheduler",
        name: "Room Scheduler",
        role: "system",
      },
      source: "system",
      kind: "system",
      content: "[Room scheduler sync packet]\nLatest message: seq 1 | messageId user-1 | from You (local-user, participant) | user_input/completed: hi",
    }),
    anchorMessageId: undefined,
    timeline: [{ id: `tool:${tool.id}`, sequence: 1, type: "tool", toolId: tool.id }],
    tools: [tool],
    emittedMessages: [],
  });

  const entries = buildRoomThreadToolEntries({
    roomId: "room-1",
    roomMessages: [createMessage({ id: "user-1", role: "user", source: "user", kind: "user_input", sender: { id: "local-user", name: "You", role: "participant" }, content: "hi" })],
    agentStates: {
      concierge: createAgentState([turn]),
    },
  });

  assert.equal(entries.get("user-1")?.[0]?.tool.id, "tool-1");
});

test("falls back to compact scheduler packet latest message id", () => {
  const tool = createTool("tool-1", 1);
  const turn = createTurn({
    userMessage: createMessage({
      id: "scheduler-1",
      roomId: "room-1",
      seq: 0,
      role: "system",
      sender: {
        id: "room-scheduler",
        name: "Room Scheduler",
        role: "system",
      },
      source: "system",
      kind: "system",
      content: "[Room scheduler sync packet]\nLatest messageId: user-1\nUnseen messages:\n- You: hi",
    }),
    anchorMessageId: undefined,
    timeline: [{ id: `tool:${tool.id}`, sequence: 1, type: "tool", toolId: tool.id }],
    tools: [tool],
    emittedMessages: [],
  });

  const entries = buildRoomThreadToolEntries({
    roomId: "room-1",
    roomMessages: [createMessage({ id: "user-1", role: "user", source: "user", kind: "user_input", sender: { id: "local-user", name: "You", role: "participant" }, content: "hi" })],
    agentStates: {
      concierge: createAgentState([turn]),
    },
  });

  assert.equal(entries.get("user-1")?.[0]?.tool.id, "tool-1");
});

test("builds draft entries anchored under the triggering visible room message", () => {
  const runningTurn = createTurn({
    status: "running",
    emittedMessages: [],
    timeline: [{ id: "draft-segment:segment-1", sequence: 1, type: "draft-segment", segmentId: "segment-1" }],
    assistantContent: "Investigating the request...",
    draftSegments: [{ id: "segment-1", sequence: 1, content: "Investigating the request...", status: "streaming" }],
  });

  const entries = buildRoomThreadDraftEntries({
    roomId: "room-1",
    roomMessages: [runningTurn.userMessage],
    agentStates: {
      concierge: createAgentState([runningTurn]),
    },
  });

  assert.equal(entries.get("user-1")?.length, 1);
  assert.equal(entries.get("user-1")?.[0]?.turn.id, "turn-1");
  assert.equal(entries.get("user-1")?.[0]?.segment.content, "Investigating the request...");
});

test("skips completed turns without draft text in room thread draft entries", () => {
  const completedTurn = createTurn({
    status: "completed",
    emittedMessages: [],
    timeline: [],
    assistantContent: "",
    draftSegments: [],
  });

  const entries = buildRoomThreadDraftEntries({
    roomId: "room-1",
    roomMessages: [completedTurn.userMessage],
    agentStates: {
      concierge: createAgentState([completedTurn]),
    },
  });

  assert.equal(entries.size, 0);
});
