import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentWorldSnapshot } from "@/components/workspace/agent-world-model";
import type { AgentRoomTurn, AgentSharedState, RoomAgentDefinition, RoomMessage, RoomParticipant, RoomSession, ToolExecution } from "@/lib/chat/types";

const AGENTS: RoomAgentDefinition[] = [
  {
    id: "concierge",
    label: "Harbor Concierge",
    summary: "General helper",
    skills: [],
    workingStyle: "",
    instruction: "",
  },
  {
    id: "operator",
    label: "Bridge Operator",
    summary: "Operations helper",
    skills: [],
    workingStyle: "",
    instruction: "",
  },
];

function createParticipant(agentId: string): RoomParticipant {
  return {
    id: agentId,
    name: agentId,
    senderRole: "participant",
    runtimeKind: "agent",
    enabled: true,
    order: 1,
    agentId,
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T10:00:00.000Z",
  };
}

function createMessage(overrides?: Partial<RoomMessage>): RoomMessage {
  return {
    id: "message-1",
    roomId: "room-1",
    seq: 1,
    role: "assistant",
    sender: { id: "concierge", name: "Harbor Concierge", role: "participant" },
    content: "Visible room reply",
    attachments: [],
    source: "agent_emit",
    kind: "answer",
    status: "completed",
    final: true,
    createdAt: "2026-04-19T10:00:00.000Z",
    receipts: [],
    receiptStatus: "none",
    receiptUpdatedAt: null,
    ...overrides,
  };
}

function createTool(overrides?: Partial<ToolExecution>): ToolExecution {
  return {
    id: "tool-1",
    sequence: 1,
    toolName: "bash",
    displayName: "Bash",
    inputSummary: "pwd",
    inputText: "pwd",
    resultPreview: "/workspace",
    outputText: "/workspace",
    status: "success",
    durationMs: 8,
    ...overrides,
  };
}

function createTurn(overrides?: Partial<AgentRoomTurn>): AgentRoomTurn {
  return {
    id: "turn-1",
    agent: {
      id: "concierge",
      label: "Harbor Concierge",
    },
    userMessage: createMessage({
      id: "user-1",
      role: "user",
      source: "user",
      kind: "user_input",
      content: "Please help",
      createdAt: "2026-04-19T10:00:00.000Z",
      sender: { id: "local-user", name: "You", role: "participant" },
    }),
    assistantContent: "Working on it",
    tools: [],
    emittedMessages: [],
    status: "completed",
    ...overrides,
  };
}

function createState(turns: AgentRoomTurn[]): AgentSharedState {
  return {
    settings: {
      modelConfigId: null,
      apiFormat: "chat_completions",
      model: "",
      systemPrompt: "",
      providerMode: "auto",
      memoryBackend: "sqlite-fts",
      compactionTokenThreshold: 200_000,
      compactionPreference: "llm_preferred",
      maxToolLoopSteps: 8,
      thinkingLevel: "off",
      enabledSkillIds: [],
    },
    agentTurns: turns,
    resolvedModel: "gpt-5.4",
    compatibility: null,
    updatedAt: "2026-04-19T10:00:10.000Z",
  };
}

function createRoom(overrides?: Partial<RoomSession>): RoomSession {
  return {
    id: "room-1",
    title: "Alpha Room",
    agentId: "concierge",
    archivedAt: null,
    pinnedAt: null,
    ownerParticipantId: "local-user",
    receiptRevision: 0,
    participants: [createParticipant("concierge"), createParticipant("operator")],
    scheduler: {
      status: "idle",
      nextAgentParticipantId: null,
      activeParticipantId: null,
      roundCount: 0,
      agentCursorByParticipantId: {},
      agentReceiptRevisionByParticipantId: {},
    },
    roomMessages: [],
    agentTurns: [],
    error: "",
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T10:00:00.000Z",
    ...overrides,
  };
}

test("keeps idle agents in resting mode", () => {
  const snapshot = buildAgentWorldSnapshot({
    agents: AGENTS,
    rooms: [createRoom()],
    agentStates: {
      concierge: createState([]),
      operator: createState([]),
    },
    currentRoomId: "room-1",
    now: Date.parse("2026-04-19T10:01:00.000Z"),
  });

  assert.equal(snapshot.agents.find((agent) => agent.agentId === "concierge")?.status, "resting");
  assert.equal(snapshot.agents.find((agent) => agent.agentId === "concierge")?.targetZone, "lounge");
});

test("keeps plain text conversation in resting mode and shows a chat bubble", () => {
  const snapshot = buildAgentWorldSnapshot({
    agents: AGENTS,
    rooms: [createRoom()],
    agentStates: {
      concierge: createState([
        createTurn({
          emittedMessages: [createMessage({ createdAt: "2026-04-19T10:00:08.000Z", content: "今天先摸会儿鱼" })],
        }),
      ]),
      operator: createState([]),
    },
    currentRoomId: "room-1",
    now: Date.parse("2026-04-19T10:00:10.000Z"),
  });

  const concierge = snapshot.agents.find((agent) => agent.agentId === "concierge");
  assert.equal(concierge?.status, "resting");
  assert.equal(concierge?.pulse?.kind, "chat");
});

test("moves an agent to working mode only when a tool is actively running", () => {
  const snapshot = buildAgentWorldSnapshot({
    agents: AGENTS,
    rooms: [createRoom()],
    agentStates: {
      concierge: createState([
        createTurn({
          status: "running",
          tools: [createTool()],
          userMessage: createMessage({
            id: "user-2",
            role: "user",
            source: "user",
            kind: "user_input",
            createdAt: "2026-04-19T10:00:20.000Z",
            sender: { id: "local-user", name: "You", role: "participant" },
          }),
        }),
      ]),
      operator: createState([]),
    },
    currentRoomId: "room-1",
    now: Date.parse("2026-04-19T10:00:25.000Z"),
  });

  const concierge = snapshot.agents.find((agent) => agent.agentId === "concierge");
  assert.equal(concierge?.status, "working");
  assert.equal(concierge?.targetZone, "workspace");
  assert.equal(concierge?.pulse?.kind, "work");
});

test("keeps an agent at the desk briefly after tool completion, then lets it rest again", () => {
  const state = {
    concierge: createState([
      createTurn({
        emittedMessages: [createMessage({ createdAt: "2026-04-19T10:00:08.000Z" })],
        tools: [createTool()],
      }),
    ]),
    operator: createState([]),
  };

  const recentSnapshot = buildAgentWorldSnapshot({
    agents: AGENTS,
    rooms: [createRoom()],
    agentStates: state,
    currentRoomId: "room-1",
    now: Date.parse("2026-04-19T10:00:11.000Z"),
  });
  const staleSnapshot = buildAgentWorldSnapshot({
    agents: AGENTS,
    rooms: [createRoom()],
    agentStates: state,
    currentRoomId: "room-1",
    now: Date.parse("2026-04-19T10:00:20.000Z"),
  });

  assert.equal(recentSnapshot.agents.find((agent) => agent.agentId === "concierge")?.status, "working");
  assert.equal(staleSnapshot.agents.find((agent) => agent.agentId === "concierge")?.status, "resting");
});
