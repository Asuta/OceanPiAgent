import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkspaceBootstrapToSnapshot,
  buildBrowserWorkspaceCacheState,
  buildWorkspaceBootstrapState,
  mergeBrowserWorkspaceIntoSnapshot,
} from "@/components/workspace/browser-workspace-cache";
import type { AgentRoomTurn, ProviderCompatibility } from "@/lib/chat/types";
import { createDefaultWorkspaceState, createRoomMessage } from "@/lib/chat/workspace-domain";

const compatibility: ProviderCompatibility = {
  providerKey: "openai",
  providerLabel: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  chatCompletionsToolStyle: "tools",
  responsesContinuation: "replay",
  responsesPayloadMode: "json",
  notes: [],
};

test("buildBrowserWorkspaceCacheState trims heavy browser cache fields", () => {
  const workspace = createDefaultWorkspaceState();
  const room = workspace.rooms[0]!;
  const roomMessages = Array.from({ length: 275 }, (_, index) =>
    createRoomMessage(room.id, index % 2 === 0 ? "user" : "assistant", `message-${index}-${"x".repeat(160)}`, index % 2 === 0 ? "user" : "agent_emit", {
      seq: index + 1,
    }),
  );
  const userMessage = roomMessages[roomMessages.length - 1]!;
  const turnFactory = (index: number): AgentRoomTurn => ({
    id: `turn-${index}`,
    agent: {
      id: "concierge",
      label: "Harbor Concierge",
    },
    userMessage,
    continuationSnapshot: "continuation".repeat(200),
    assistantContent: `assistant-${index}-${"a".repeat(30_000)}`,
    draftSegments: [
      {
        id: `draft-${index}`,
        sequence: 1,
        content: "draft".repeat(2_500),
        status: "completed",
      },
    ],
    timeline: [
      {
        id: `tool-event-${index}`,
        sequence: 1,
        type: "tool",
        toolId: `tool-${index}`,
      },
    ],
    tools: [
      {
        id: `tool-${index}`,
        sequence: 1,
        toolName: "workspace_read",
        displayName: "workspace_read",
        inputSummary: "summary",
        inputText: "input".repeat(1_500),
        resultPreview: "preview",
        outputText: "output".repeat(1_500),
        status: "success",
        durationMs: 12,
      },
    ],
    emittedMessages: [createRoomMessage(room.id, "assistant", "tool-emitted", "agent_emit", { seq: 999 + index })],
    status: "completed",
    meta: {
      apiFormat: "responses",
      compatibility,
      responseId: `response-${index}`,
      sessionId: `session-${index}`,
      continuation: {
        strategy: "replay",
        previousResponseId: `previous-${index}`,
      },
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
      },
      historyDelta: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "history",
            },
          ],
          api: "responses",
          provider: "openai",
          model: "gpt-5.4",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      ],
    },
    resolvedModel: "gpt-5.4",
  });

  workspace.rooms = [
    {
      ...room,
      roomMessages,
      agentTurns: [turnFactory(0)],
    },
  ];
  workspace.agentStates.concierge = {
    ...workspace.agentStates.concierge,
    agentTurns: Array.from({ length: 85 }, (_, index) => turnFactory(index)),
    compatibility,
  };

  const cachedState = buildBrowserWorkspaceCacheState(workspace);
  const cachedTurn = cachedState.agentStates.concierge!.agentTurns[79]!;
  const cachedTool = cachedTurn.tools[0]!;

  assert.equal(cachedState.rooms[0]?.roomMessages.length, 250);
  assert.equal(cachedState.rooms[0]?.agentTurns.length, 0);
  assert.equal(cachedState.agentStates.concierge?.agentTurns.length, 80);
  assert.equal(cachedTool.inputText, "");
  assert.equal(cachedTool.outputText, "");
  assert.equal(cachedTurn.continuationSnapshot, undefined);
  assert.equal(cachedTurn.meta?.historyDelta, undefined);
  assert.deepEqual(cachedTurn.meta?.usage, {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
  });
});

test("applyWorkspaceBootstrapToSnapshot only applies valid selections", () => {
  const workspace = createDefaultWorkspaceState();
  const currentActiveRoomId = workspace.activeRoomId;
  const currentSelectedConsoleAgentId = workspace.selectedConsoleAgentId;

  const invalidBootstrap = {
    version: 1 as const,
    activeRoomId: "missing-room",
    selectedConsoleAgentId: "missing-agent",
    savedAt: new Date().toISOString(),
  };
  const unchanged = applyWorkspaceBootstrapToSnapshot(workspace, invalidBootstrap);

  assert.equal(unchanged.activeRoomId, currentActiveRoomId);
  assert.equal(unchanged.selectedConsoleAgentId, currentSelectedConsoleAgentId);

  const validBootstrap = buildWorkspaceBootstrapState({
    activeRoomId: currentActiveRoomId,
    selectedConsoleAgentId: currentSelectedConsoleAgentId,
  });
  const updated = applyWorkspaceBootstrapToSnapshot(workspace, validBootstrap);

  assert.equal(updated.activeRoomId, currentActiveRoomId);
  assert.equal(updated.selectedConsoleAgentId, currentSelectedConsoleAgentId);
});

test("mergeBrowserWorkspaceIntoSnapshot restores richer room history without reviving deleted rooms", () => {
  const serverWorkspace = createDefaultWorkspaceState();
  const browserWorkspace = createDefaultWorkspaceState();
  const room = serverWorkspace.rooms[0]!;

  const userMessage = createRoomMessage(room.id, "user", "first", "user", { seq: 1 });
  const answerMessage = createRoomMessage(room.id, "assistant", "second", "agent_emit", { seq: 2 });

  serverWorkspace.rooms = [
    {
      ...room,
      roomMessages: [answerMessage],
    },
  ];
  serverWorkspace.agentStates.concierge = {
    ...serverWorkspace.agentStates.concierge,
    agentTurns: [],
  };

  browserWorkspace.rooms = [
    {
      ...browserWorkspace.rooms[0]!,
      id: room.id,
      roomMessages: [userMessage, answerMessage],
    },
    {
      ...createDefaultWorkspaceState().rooms[0]!,
      id: "browser-only-room",
    },
  ];

  const restored = mergeBrowserWorkspaceIntoSnapshot(serverWorkspace, browserWorkspace);

  assert.equal(restored.rooms.length, 1);
  assert.equal(restored.rooms[0]?.roomMessages.length, 2);
  assert.equal(restored.rooms[0]?.roomMessages[0]?.id, userMessage.id);
  assert.equal(restored.rooms[0]?.roomMessages[1]?.id, answerMessage.id);
});
