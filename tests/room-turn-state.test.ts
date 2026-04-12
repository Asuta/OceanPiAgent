import assert from "node:assert/strict";
import test from "node:test";
import { buildRoomThreadToolEntries } from "@/components/workspace/room-thread";
import { upsertRoomMessageInTurn } from "@/components/workspace/room-turn-state";
import type { AgentRoomTurn, AgentSharedState, RoomMessage, ToolExecution } from "@/lib/chat/types";

function createTool(id: string, sequence: number): ToolExecution {
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
    createdAt: "2026-03-31T13:40:00.000Z",
    receipts: [],
    receiptStatus: "none",
    receiptUpdatedAt: null,
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
    updatedAt: "2026-03-31T13:40:00.000Z",
  };
}

test("upsertRoomMessageInTurn immediately reanchors later tools under a streamed room message", () => {
  const firstTool = createTool("tool-1", 1);
  const secondTool = createTool("tool-2", 3);
  const userMessage = createMessage({
    id: "user-1",
    role: "user",
    source: "user",
    kind: "user_input",
    sender: {
      id: "local-user",
      name: "You",
      role: "participant",
    },
    content: "请先发一个进度，再继续查资料。",
    createdAt: "2026-03-31T13:39:00.000Z",
  });
  const streamedMessage = createMessage({
    id: "answer-1",
    seq: 2,
    kind: "progress",
    status: "streaming",
    final: false,
    content: "收到，我先同步一下进度。",
  });
  const runningTurn: AgentRoomTurn = {
    id: "turn-1",
    agent: {
      id: "concierge",
      label: "Harbor Concierge",
    },
    userMessage,
    assistantContent: "",
    timeline: [{ id: `tool:${firstTool.id}`, sequence: 1, type: "tool", toolId: firstTool.id }],
    tools: [firstTool],
    emittedMessages: [],
    status: "running",
  };

  const turnWithRoomMessage = upsertRoomMessageInTurn(runningTurn, streamedMessage);
  const turnWithLaterTool: AgentRoomTurn = {
    ...turnWithRoomMessage,
    tools: [...turnWithRoomMessage.tools, secondTool],
    timeline: [
      ...(turnWithRoomMessage.timeline ?? []),
      { id: `tool:${secondTool.id}`, sequence: 3, type: "tool", toolId: secondTool.id },
    ],
  };

  const entries = buildRoomThreadToolEntries({
    roomId: "room-1",
    roomMessages: [userMessage, streamedMessage],
    agentStates: {
      concierge: createAgentState([turnWithLaterTool]),
    },
  });

  assert.equal(entries.get("user-1")?.[0]?.tool.id, "tool-1");
  assert.equal(entries.get("answer-1")?.[0]?.tool.id, "tool-2");
});

test("upsertRoomMessageInTurn keeps one timeline room-message event while preview content updates stream in", () => {
  const userMessage = createMessage({
    id: "user-1",
    role: "user",
    source: "user",
    kind: "user_input",
    sender: {
      id: "local-user",
      name: "You",
      role: "participant",
    },
    content: "先给我一个进度播报。",
    createdAt: "2026-03-31T13:39:00.000Z",
  });
  const previewMessage = createMessage({
    id: "answer-1",
    seq: 2,
    kind: "progress",
    status: "streaming",
    final: false,
    content: "收到，正在查看",
  });
  const updatedPreviewMessage = {
    ...previewMessage,
    content: "收到，正在查看今天的最新榜单...",
  };
  const runningTurn: AgentRoomTurn = {
    id: "turn-1",
    agent: {
      id: "concierge",
      label: "Harbor Concierge",
    },
    userMessage,
    assistantContent: "",
    timeline: [],
    tools: [],
    emittedMessages: [],
    status: "running",
  };

  const firstUpdate = upsertRoomMessageInTurn(runningTurn, previewMessage);
  const secondUpdate = upsertRoomMessageInTurn(firstUpdate, updatedPreviewMessage);

  assert.equal(secondUpdate.emittedMessages.length, 1);
  assert.equal(secondUpdate.emittedMessages[0]?.content, "收到，正在查看今天的最新榜单...");
  assert.equal(secondUpdate.timeline?.filter((event) => event.type === "room-message").length, 1);
});
