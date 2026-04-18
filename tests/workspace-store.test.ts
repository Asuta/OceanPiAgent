import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type WorkspaceDomainModule = typeof import("../src/lib/chat/workspace-domain");
type WorkspaceStoreModule = typeof import("../src/lib/server/workspace-store");

const repoRoot = process.cwd();

async function withTempCwd(run: (mods: { domain: WorkspaceDomainModule; store: WorkspaceStoreModule }) => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-workspace-store-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    const nonce = `${Date.now()}-${Math.random()}`;
    const domain = (await import(`${pathToFileURL(path.join(repoRoot, "src/lib/chat/workspace-domain.ts")).href}?test=${nonce}`)) as WorkspaceDomainModule;
    const store = (await import(`${pathToFileURL(path.join(repoRoot, "src/lib/server/workspace-store.ts")).href}?test=${nonce}`)) as WorkspaceStoreModule;
    await run({ domain, store });
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("workspace store rejects invalid state payloads", async () => {
  await withTempCwd(async ({ store }) => {
    await assert.rejects(
      store.saveWorkspaceState({
        expectedVersion: 0,
        state: {
          rooms: [],
          agentStates: {},
          activeRoomId: 123,
        } as never,
      }),
    );
  });
});

test("workspace store persists valid workspace envelopes", async () => {
  await withTempCwd(async ({ domain, store }) => {
    const state = domain.createDefaultWorkspaceState();
    const saved = await store.saveWorkspaceState({
      expectedVersion: 0,
      state,
    });

    const loaded = await store.loadWorkspaceEnvelope();
    assert.equal(saved.version, 1);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.state.activeRoomId, state.activeRoomId);
    assert.equal(loaded.state.rooms.length, 1);
  });
});

test("workspace store preserves server room history when a stale client snapshot omits messages", async () => {
  await withTempCwd(async ({ domain, store }) => {
    const state = domain.createDefaultWorkspaceState();
    const room = state.rooms[0]!;
    const originalMessage = {
      ...domain.createRoomMessage(room.id, "user", "first", "user"),
      id: "user-msg-1",
      seq: 1,
    };
    const newerMessage = {
      ...domain.createRoomMessage(room.id, "user", "missing-from-client", "user"),
      id: "user-msg-2",
      seq: 2,
    };

    state.rooms[0] = {
      ...room,
      roomMessages: [originalMessage, newerMessage],
    };

    const initialEnvelope = await store.loadWorkspaceEnvelope();
    const firstSave = await store.saveWorkspaceState({
      expectedVersion: initialEnvelope.version,
      state,
    });

    const staleClientState = structuredClone(firstSave.state);
    staleClientState.rooms[0] = {
      ...staleClientState.rooms[0]!,
      roomMessages: staleClientState.rooms[0]!.roomMessages.filter((message) => message.id !== newerMessage.id),
    };
    staleClientState.agentStates[room.agentId] = {
      ...staleClientState.agentStates[room.agentId],
      settings: {
        ...staleClientState.agentStates[room.agentId]!.settings,
        systemPrompt: "updated by client",
      },
    };

    const latestEnvelope = await store.loadWorkspaceEnvelope();
    const saved = await store.saveWorkspaceState({
      expectedVersion: latestEnvelope.version,
      state: staleClientState,
    });

    const savedRoom = saved.state.rooms.find((entry) => entry.id === room.id);
    assert.ok(savedRoom);
    assert.equal(savedRoom?.roomMessages.some((message) => message.id === newerMessage.id), true);
    assert.equal(saved.state.agentStates[room.agentId]?.settings.systemPrompt, "updated by client");
  });
});

test("workspace store accepts assistant history tool-call parts with partialJson", async () => {
  await withTempCwd(async ({ domain, store }) => {
    const state = domain.createDefaultWorkspaceState();
    const room = state.rooms[0]!;
    const userMessage = {
      ...domain.createRoomMessage(room.id, "user", "ping", "user"),
      id: "user-msg-1",
      seq: 1,
    };

    state.rooms[0] = {
      ...room,
      roomMessages: [userMessage],
      agentTurns: [
        {
          id: "turn-1",
          agent: {
            id: room.agentId,
            label: "Harbor Concierge",
          },
          userMessage,
          assistantContent: "",
          tools: [],
          emittedMessages: [],
          status: "completed",
          meta: {
            apiFormat: "chat_completions",
            compatibility: {
              providerKey: "generic",
              providerLabel: "Generic",
              baseUrl: "https://example.test/v1",
              chatCompletionsToolStyle: "tools",
              responsesContinuation: "replay",
              responsesPayloadMode: "json",
              notes: [],
            },
            historyDelta: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "tool-1",
                    name: "send_message_to_room",
                    arguments: {},
                    partialJson: '{"roomId":"room-1","content":"hello"}',
                  },
                ],
                api: "chat_completions",
                provider: "generic",
                model: "fake-model",
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
                stopReason: "toolUse",
                timestamp: Date.now(),
              },
            ],
          },
          resolvedModel: "generic/fake-model",
        },
      ],
    };
    state.agentStates[room.agentId] = {
      ...state.agentStates[room.agentId],
      agentTurns: state.rooms[0].agentTurns,
      resolvedModel: "generic/fake-model",
      compatibility: {
        providerKey: "generic",
        providerLabel: "Generic",
        baseUrl: "https://example.test/v1",
        chatCompletionsToolStyle: "tools",
        responsesContinuation: "replay",
        responsesPayloadMode: "json",
        notes: [],
      },
      updatedAt: new Date().toISOString(),
    };

    const currentEnvelope = await store.loadWorkspaceEnvelope();
    const saved = await store.saveWorkspaceState({
      expectedVersion: currentEnvelope.version,
      state,
    });

    assert.equal(saved.version, currentEnvelope.version + 1);
  });
});
