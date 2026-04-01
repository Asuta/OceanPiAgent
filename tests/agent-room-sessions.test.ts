import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type AgentRoomSessionsModule = typeof import("../src/lib/server/agent-room-sessions");
type AgentContextStoreModule = typeof import("../src/lib/server/agent-context-store");

const repoRoot = process.cwd();

const TEST_COMPATIBILITY = {
  providerKey: "openai" as const,
  providerLabel: "OpenAI Compatible",
  baseUrl: "https://example.test/v1",
  chatCompletionsToolStyle: "tools" as const,
  responsesContinuation: "replay" as const,
  responsesPayloadMode: "json" as const,
  notes: [],
};

async function withAgentSessionModules(
  run: (roomSessions: AgentRoomSessionsModule, contextStore: AgentContextStoreModule) => Promise<void>,
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-agent-room-sessions-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  const roomSessionsUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-room-sessions.ts")).href;
  const contextStoreUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-context-store.ts")).href;

  try {
    const [roomSessions, contextStore] = await Promise.all([
      import(`${roomSessionsUrl}?test=${Date.now()}-${Math.random()}`) as Promise<AgentRoomSessionsModule>,
      import(contextStoreUrl) as Promise<AgentContextStoreModule>,
    ]);
    await run(roomSessions, contextStore);
    await contextStore.closeAgentContextStore();
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("agent room sessions dual-write incoming messages, continuation snapshots, and completed runs", async () => {
  await withAgentSessionModules(async (roomSessions, contextStore) => {
    const agentId = `concierge-${Date.now()}`;
    const requestController = new AbortController();

    const firstRun = await roomSessions.startAgentRoomRun({
      agentId,
      roomId: "room-alpha",
      roomTitle: "Alpha Room",
      attachedRooms: [{ id: "room-alpha", title: "Alpha Room" }],
      userMessageId: "room-msg-1",
      userSender: {
        id: "user-1",
        name: "You",
        role: "participant",
      },
      userContent: "Need a rollout update.",
      userAttachments: [],
      requestSignal: requestController.signal,
    });

    roomSessions.recordAgentTextDelta(agentId, firstRun.requestId, "Collecting rollout notes.");
    roomSessions.recordAgentToolEvent(agentId, firstRun.requestId, {
      id: "tool-1",
      sequence: 1,
      toolName: "workspace_read",
      displayName: "workspace_read",
      inputSummary: "deployment-plan.md",
      inputText: "deployment-plan.md",
      resultPreview: "Loaded rollout and rollback notes.",
      outputText: "Loaded rollout and rollback notes.",
      status: "success",
      durationMs: 12,
      roomMessage: {
        roomId: "room-alpha",
        content: "Reviewing rollout and rollback notes.",
        kind: "progress",
        status: "completed",
        final: false,
      },
      roomAction: {
        type: "read_no_reply",
        roomId: "room-alpha",
        messageId: "room-msg-1",
      },
    });

    const secondRun = await roomSessions.startAgentRoomRun({
      agentId,
      roomId: "room-beta",
      roomTitle: "Beta Room",
      attachedRooms: [
        { id: "room-alpha", title: "Alpha Room" },
        { id: "room-beta", title: "Beta Room" },
      ],
      userMessageId: "room-msg-2",
      userSender: {
        id: "user-1",
        name: "You",
        role: "participant",
      },
      userContent: "Also prepare a short beta-room update.",
      userAttachments: [],
      requestSignal: requestController.signal,
    });

    assert.match(secondRun.continuationSnapshot ?? "", /unfinished shared agent run/);

    await roomSessions.completeAgentRoomRun({
      agentId,
      requestId: secondRun.requestId,
      assistantText: "Prepared the beta-room update and kept the alpha-room obligation in mind.",
      resolvedModel: "gpt-test",
      compatibility: TEST_COMPATIBILITY,
    });

    const snapshot = await contextStore.getAgentContextConversationSnapshot(agentId);

    assert.ok(snapshot);
    assert.equal(snapshot?.messages.length, 4);
    assert.deepEqual(
      snapshot?.messages.map((message) => message.source),
      ["room_incoming", "continuation_snapshot", "room_incoming", "room_run_completion"],
    );
    assert.equal(snapshot?.messages[0]?.content, "Need a rollout update.");
    assert.equal(snapshot?.messages[2]?.content, "Also prepare a short beta-room update.");
    assert.equal(snapshot?.messages[3]?.resolvedModel, "gpt-test");

    const continuationParts = snapshot?.messages[1]?.parts ?? [];
    assert.ok(continuationParts.some((part) => part.partType === "continuation_snapshot"));
    assert.ok(continuationParts.some((part) => part.partType === "assistant_partial_draft"));
    assert.ok(continuationParts.some((part) => part.partType === "tool_result"));
    assert.ok(continuationParts.some((part) => part.partType === "room_delivery"));
    assert.ok(continuationParts.some((part) => part.partType === "room_action"));

    const completionParts = snapshot?.messages[3]?.parts ?? [];
    assert.ok(completionParts.some((part) => part.partType === "assistant_history_entry"));
    assert.equal(snapshot?.messages[3]?.compatibility?.providerKey, "openai");

    await roomSessions.resetAgentRoomSession(agentId);
  });
});
