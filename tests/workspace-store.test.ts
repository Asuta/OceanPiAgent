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
