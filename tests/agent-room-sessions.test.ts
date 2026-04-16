import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadWorkspaceEnvelope, saveWorkspaceState } from "@/lib/server/workspace-store";
import { __testing as agentCompactionTesting } from "@/lib/server/agent-compaction";

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

test.skip("agent room sessions dual-write incoming messages, continuation snapshots, and completed runs", async () => {
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

    await roomSessions.resetAgentRoomSession(agentId);
  });
});

test("startAgentRoomRun waits for pending automatic compaction before reusing session history", async () => {
  await withAgentSessionModules(async (roomSessions) => {
    const agentId = "concierge";
    const requestController = new AbortController();
    const workspace = await loadWorkspaceEnvelope();
    await saveWorkspaceState({
      expectedVersion: workspace.version,
      state: {
        ...workspace.state,
        agentStates: {
          ...workspace.state.agentStates,
          [agentId]: {
            ...workspace.state.agentStates[agentId],
            settings: {
              ...workspace.state.agentStates[agentId].settings,
              compactionTokenThreshold: 1_000,
              compactionFreshTailCount: 0,
            },
          },
        },
      },
    });

    let releaseCompaction!: () => void;
    const compactionStarted = new Promise<void>((resolveStarted) => {
      const compactionBlocked = new Promise<void>((resolveBlocked) => {
        releaseCompaction = resolveBlocked;
      });
      agentCompactionTesting.setGenerateCompactionSummaryOverride(async () => {
        resolveStarted();
        await compactionBlocked;
        return [
          "## 关键结论",
          "- 自动压缩测试摘要。",
          "",
          "## 待办事项",
          "- 无",
          "",
          "## 约束与规则",
          "- 无",
          "",
          "## 用户仍在等待的问题",
          "- 无",
          "",
          "## 精确标识符",
          "- `room-scheduler`",
        ].join("\n");
      });
    });

    try {
      const firstRun = await roomSessions.startAgentRoomRun({
        agentId,
        roomId: "room-1",
        roomTitle: "Room 1",
        attachedRooms: [{ id: "room-1", title: "Room 1" }],
        userMessageId: "room-msg-1",
        userSender: {
          id: "user-1",
          name: "You",
          role: "participant",
        },
        userContent: "First message",
        userAttachments: [],
        requestSignal: requestController.signal,
      });

      await roomSessions.completeAgentRoomRun({
        agentId,
        requestId: firstRun.requestId,
        assistantText: "A very long assistant answer. ".repeat(600),
        resolvedModel: "gpt-test",
        compatibility: TEST_COMPATIBILITY,
      });

      await compactionStarted;

      let secondRunResolved = false;
      const secondRunPromise = roomSessions.startAgentRoomRun({
        agentId,
        roomId: "room-2",
        roomTitle: "Room 2",
        attachedRooms: [{ id: "room-2", title: "Room 2" }],
        userMessageId: "room-msg-2",
        userSender: {
          id: "user-1",
          name: "You",
          role: "participant",
        },
        userContent: "Second message",
        userAttachments: [],
        requestSignal: requestController.signal,
      }).then((value) => {
        secondRunResolved = true;
        return value;
      });

      await delay(50);
      assert.equal(secondRunResolved, false);

      releaseCompaction();
      const secondRun = await secondRunPromise;
      assert.equal(secondRun.history.length > 0, true);
    } finally {
      agentCompactionTesting.setGenerateCompactionSummaryOverride(undefined);
      await roomSessions.resetAgentRoomSession(agentId);
    }
  });
});

test("startAgentRoomRun waits for an active run in another room instead of superseding it", async () => {
  await withAgentSessionModules(async (roomSessions) => {
    const agentId = `concierge-${Date.now()}`;
    const requestController = new AbortController();
    const workspace = await loadWorkspaceEnvelope();
    const roomAlphaId = workspace.state.rooms[0]?.id ?? "room-alpha";
    const roomAlphaTitle = workspace.state.rooms[0]?.title ?? "Alpha Room";
    await saveWorkspaceState({
      expectedVersion: workspace.version,
      state: {
        ...workspace.state,
        rooms: workspace.state.rooms.map((room, index) => (
          index === 0
            ? {
                ...room,
                scheduler: {
                  ...room.scheduler,
                  status: "running",
                },
              }
            : room
        )),
      },
    });

    const firstRun = await roomSessions.startAgentRoomRun({
      agentId,
      roomId: roomAlphaId,
      roomTitle: roomAlphaTitle,
      attachedRooms: [{ id: roomAlphaId, title: roomAlphaTitle }],
      userMessageId: "room-msg-1",
      userSender: {
        id: "user-1",
        name: "You",
        role: "participant",
      },
      userContent: "Need an alpha update.",
      userAttachments: [],
      requestSignal: requestController.signal,
    });

    let secondRunResolved = false;
    const secondRunPromise = roomSessions.startAgentRoomRun({
      agentId,
      roomId: "room-beta",
      roomTitle: "Beta Room",
      attachedRooms: [{ id: "room-beta", title: "Beta Room" }],
      userMessageId: "room-msg-2",
      userSender: {
        id: "user-1",
        name: "You",
        role: "participant",
      },
      userContent: "Need a beta update too.",
      userAttachments: [],
      requestSignal: requestController.signal,
    }).then((value) => {
      secondRunResolved = true;
      return value;
    });

    await delay(50);
    assert.equal(secondRunResolved, false);
    assert.equal(firstRun.signal.aborted, false);

    await roomSessions.completeAgentRoomRun({
      agentId,
      requestId: firstRun.requestId,
      assistantText: "Alpha complete.",
      resolvedModel: "gpt-test",
      compatibility: TEST_COMPATIBILITY,
    });

    const secondRun = await secondRunPromise;
    assert.equal(firstRun.signal.aborted, false);
    assert.equal(secondRun.requestId.length > 0, true);

    roomSessions.clearActiveAgentRoomRunForRoom(agentId, "room-beta", "Cleanup.");
    await roomSessions.resetAgentRoomSession(agentId);
  });
});

test("startAgentRoomRun still supersedes an active run in the same room", async () => {
  await withAgentSessionModules(async (roomSessions) => {
    const agentId = `concierge-${Date.now()}-same-room`;
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
      userContent: "First message",
      userAttachments: [],
      requestSignal: requestController.signal,
    });

    await roomSessions.startAgentRoomRun({
      agentId,
      roomId: "room-alpha",
      roomTitle: "Alpha Room",
      attachedRooms: [{ id: "room-alpha", title: "Alpha Room" }],
      userMessageId: "room-msg-2",
      userSender: {
        id: "user-1",
        name: "You",
        role: "participant",
      },
      userContent: "Second message",
      userAttachments: [],
      requestSignal: requestController.signal,
    });

    assert.equal(firstRun.signal.aborted, true);
    assert.match(firstRun.signal.reason instanceof Error ? firstRun.signal.reason.message : String(firstRun.signal.reason), /Superseded by a newer room message\./);

    roomSessions.clearActiveAgentRoomRunForRoom(agentId, "room-alpha", "Cleanup.");
    await roomSessions.resetAgentRoomSession(agentId);
  });
});
