import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type ChannelDeliveryQueueModule = typeof import("../src/lib/server/channel-delivery-queue");

const repoRoot = process.cwd();

async function importQueueModule(nonce: string): Promise<ChannelDeliveryQueueModule> {
  return (await import(`${pathToFileURL(path.join(repoRoot, "src/lib/server/channel-delivery-queue.ts")).href}?test=${nonce}`)) as ChannelDeliveryQueueModule;
}

test("channel delivery dedupe survives module reloads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-channel-queue-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    const messageKey = "feishu:default:om_test_persist";

    const firstModule = await importQueueModule(`first-${Date.now()}`);
    await firstModule.resetChannelDeliveryStateForTest();
    const firstState = await firstModule.beginInboundMessage(messageKey);
    assert.equal(firstState, "started");
    await firstModule.finishInboundMessage(messageKey, true);

    const secondModule = await importQueueModule(`second-${Date.now()}`);
    const secondState = await secondModule.beginInboundMessage(messageKey);
    assert.equal(secondState, "processed");
    await secondModule.resetChannelDeliveryStateForTest();
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});
