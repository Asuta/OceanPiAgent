import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type ChannelBindingsStoreModule = typeof import("../src/lib/server/channel-bindings-store");

const repoRoot = process.cwd();

async function withTempCwd(run: (store: ChannelBindingsStoreModule) => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-channel-bindings-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    const nonce = `${Date.now()}-${Math.random()}`;
    const store = (await import(`${pathToFileURL(path.join(repoRoot, "src/lib/server/channel-bindings-store.ts")).href}?test=${nonce}`)) as ChannelBindingsStoreModule;
    await run(store);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("channel bindings store persists and updates Feishu bindings", async () => {
  await withTempCwd(async (store) => {
    const createdAt = new Date().toISOString();
    await store.upsertChannelBinding({
      bindingId: "binding-1",
      channel: "feishu",
      accountId: "default",
      peerKind: "direct",
      peerId: "ou_123",
      roomId: "room-1",
      humanParticipantId: "feishu:default:direct:ou_123",
      agentId: "concierge",
      createdAt,
      updatedAt: createdAt,
      lastInboundAt: null,
    });

    const found = await store.findChannelBinding({
      channel: "feishu",
      accountId: "default",
      peerKind: "direct",
      peerId: "ou_123",
    });

    assert.ok(found);
    assert.equal(found?.roomId, "room-1");

    const touched = await store.touchChannelBinding({
      channel: "feishu",
      accountId: "default",
      peerKind: "direct",
      peerId: "ou_123",
      lastInboundAt: "2026-03-27T10:00:00.000Z",
    });

    assert.equal(touched?.lastInboundAt, "2026-03-27T10:00:00.000Z");

    const allBindings = await store.loadChannelBindings();
    assert.equal(allBindings.length, 1);
    assert.equal(allBindings[0]?.bindingId, "binding-1");
  });
});
