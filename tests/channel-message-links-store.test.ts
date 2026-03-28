import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type ChannelMessageLinksStoreModule = typeof import("../src/lib/server/channel-message-links-store");

const repoRoot = process.cwd();

async function withTempCwd(run: (store: ChannelMessageLinksStoreModule) => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-channel-message-links-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    const nonce = `${Date.now()}-${Math.random()}`;
    const store = (await import(`${pathToFileURL(path.join(repoRoot, "src/lib/server/channel-message-links-store.ts")).href}?test=${nonce}`)) as ChannelMessageLinksStoreModule;
    await run(store);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("channel message links store persists reactions for Feishu messages", async () => {
  await withTempCwd(async (store) => {
    const link = store.createChannelMessageLink({
      linkId: "link-1",
      channel: "feishu",
      accountId: "default",
      peerKind: "direct",
      peerId: "ou_123",
      externalMessageId: "om_123",
      roomId: "room-1",
      roomMessageId: "room-message-1",
      messageType: "text",
      createdAt: "2026-03-28T10:00:00.000Z",
    });

    await store.upsertChannelMessageLink(link);
    const found = await store.findChannelMessageLink({
      channel: "feishu",
      accountId: "default",
      externalMessageId: "om_123",
    });

    assert.ok(found);
    assert.equal(found?.roomMessageId, "room-message-1");

    const updated = await store.markChannelMessageReaction({
      channel: "feishu",
      accountId: "default",
      externalMessageId: "om_123",
      reactionKind: "ackReaction",
      reaction: {
        emojiType: "OK",
        appliedAt: "2026-03-28T10:01:00.000Z",
        reactionId: "reaction-1",
      },
    });

    assert.equal(updated?.ackReaction?.emojiType, "OK");
    assert.equal(updated?.ackReaction?.reactionId, "reaction-1");
  });
});
