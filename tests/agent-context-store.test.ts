import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type AgentContextStoreModule = typeof import("../src/lib/server/agent-context-store");

const repoRoot = process.cwd();

async function withContextStoreModule(
  run: (contextStore: AgentContextStoreModule, tempDir: string) => Promise<void>,
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-agent-context-store-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  const moduleUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-context-store.ts")).href;

  try {
    const contextStore = await import(`${moduleUrl}?test=${Date.now()}-${Math.random()}`) as AgentContextStoreModule;
    await run(contextStore, tempDir);
    await contextStore.closeAgentContextStore();
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("agent context store persists ordered messages and parts for a shared agent conversation", async () => {
  await withContextStoreModule(async (contextStore) => {
    await contextStore.appendAgentContextMessage({
      agentId: "concierge",
      messageId: "msg-incoming-1",
      role: "user",
      source: "room_incoming",
      content: "Need a rollout update.",
      createdAt: "2026-04-01T10:00:00.000Z",
      requestId: "req-1",
      roomId: "room-alpha",
      roomTitle: "Alpha",
      userMessageId: "room-msg-1",
      sender: {
        id: "user-1",
        name: "You",
        role: "participant",
      },
      metadata: {
        attachedRooms: [{ id: "room-alpha", title: "Alpha" }],
      },
      parts: [
        {
          partType: "incoming_room_envelope",
          textContent: "[Incoming Chat Room message]\nVisible room message:\nNeed a rollout update.",
        },
        {
          partType: "attached_rooms",
          textContent: "1. Alpha (roomId: room-alpha; current, routable)",
        },
      ],
    });

    await contextStore.appendAgentContextMessage({
      agentId: "concierge",
      messageId: "msg-assistant-1",
      role: "assistant",
      source: "room_run_completion",
      content: "I am drafting the rollout update.",
      createdAt: "2026-04-01T10:01:00.000Z",
      requestId: "req-1",
      roomId: "room-alpha",
      roomTitle: "Alpha",
      userMessageId: "room-msg-1",
      resolvedModel: "gpt-test",
      metadata: {
        roomActionCount: 1,
      },
      parts: [
        {
          partType: "assistant_history_entry",
          textContent: "[Shared agent room action summary]",
        },
        {
          partType: "room_action",
          textContent: "read_no_reply for room room-alpha, message room-msg-1",
          roomAction: {
            type: "read_no_reply",
            roomId: "room-alpha",
            messageId: "room-msg-1",
          },
        },
      ],
    });

    const snapshot = await contextStore.getAgentContextConversationSnapshot("concierge");

    assert.ok(snapshot);
    assert.equal(snapshot?.messages.length, 2);
    assert.equal(snapshot?.messages[0]?.messageId, "msg-incoming-1");
    assert.equal(snapshot?.messages[0]?.parts[0]?.partType, "incoming_room_envelope");
    assert.equal(snapshot?.messages[1]?.messageId, "msg-assistant-1");
    assert.equal(snapshot?.messages[1]?.resolvedModel, "gpt-test");
    assert.equal(snapshot?.messages[1]?.parts[1]?.partType, "room_action");
    assert.deepEqual(snapshot?.messages[1]?.parts[1]?.roomAction, {
      type: "read_no_reply",
      roomId: "room-alpha",
      messageId: "room-msg-1",
    });
  });
});
