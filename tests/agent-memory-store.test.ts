import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { closeLcmDatabase } from "@/lib/server/lcm/db";

type MemoryStoreModule = typeof import("../src/lib/server/agent-memory-store");
type LcmFacadeModule = typeof import("../src/lib/server/lcm/facade");

const repoRoot = process.cwd();

async function withModules(
  run: (modules: { memoryStore: MemoryStoreModule; lcmFacade: LcmFacadeModule; tempDir: string }) => Promise<void>,
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-agent-memory-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  const memoryStoreUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-memory-store.ts")).href;
  const lcmFacadeUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/lcm/facade.ts")).href;
  const querySuffix = `?test=${Date.now()}-${Math.random()}`;

  try {
    const [memoryStore, lcmFacade] = await Promise.all([
      import(`${memoryStoreUrl}${querySuffix}`) as Promise<MemoryStoreModule>,
      import(`${lcmFacadeUrl}${querySuffix}`) as Promise<LcmFacadeModule>,
    ]);
    await run({ memoryStore, lcmFacade, tempDir });
  } finally {
    await closeLcmDatabase();
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("agent memory search, describe, and expand use structured LCM handles", async () => {
  await withModules(async ({ memoryStore, lcmFacade }) => {
    const agentId = "concierge";
    const conversation = await lcmFacade.getOrCreateAgentConversation(agentId);
    const firstMessageId = await lcmFacade.appendAgentLcmMessage({
      agentId,
      role: "user",
      content: "Need the phoenix rollback plan.",
      createdAt: "2026-04-01T12:00:00.000Z",
      title: "Alpha Room",
    });
    const secondMessageId = await lcmFacade.appendAgentLcmMessage({
      agentId,
      role: "assistant",
      content: "Prepared the rollout response.",
      createdAt: "2026-04-01T12:01:00.000Z",
      title: "Alpha Room",
    });

    const { summaryStore } = await lcmFacade.getLcmStores();
    await summaryStore.insertSummary({
      summaryId: "sum_test_phoenix",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Phoenix rollback summary with the short room-ready answer.",
      tokenCount: 24,
      descendantCount: 2,
      descendantTokenCount: 24,
      sourceMessageTokenCount: 24,
      model: "test",
    });
    await summaryStore.linkSummaryToMessages("sum_test_phoenix", [firstMessageId, secondMessageId]);
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_test_phoenix");

    const searchResults = await memoryStore.searchAgentMemory(agentId, "phoenix rollback", { maxResults: 5 });
    const messageHit = searchResults.find((result) => result.handle === `message:${firstMessageId}`);
    const summaryHit = searchResults.find((result) => result.handle === "summary:sum_test_phoenix");
    const summaryDescription = await memoryStore.describeAgentMemory(agentId, "summary:sum_test_phoenix");
    const expandedSummary = await memoryStore.expandAgentMemory(agentId, {
      handle: "summary:sum_test_phoenix",
      depth: 1,
      includeMessages: true,
      maxItems: 10,
    });

    assert.ok(messageHit);
    assert.ok(summaryHit);
    assert.equal(summaryDescription?.type, "summary");
    assert.deepEqual(summaryDescription?.summary?.messageIds, [firstMessageId, secondMessageId]);
    assert.equal(expandedSummary?.type, "summary");
    assert.ok(expandedSummary?.messages.some((message) => message.messageId === firstMessageId));
    assert.ok(expandedSummary?.messages.some((message) => message.content.includes("phoenix rollback")));
  });
});

test("agent memory status and refresh always report structured LCM storage", async () => {
  await withModules(async ({ memoryStore, lcmFacade }) => {
    const agentId = "operator";
    await lcmFacade.appendAgentLcmMessage({
      agentId,
      role: "user",
      content: "Track the phoenix launch handoff.",
      createdAt: "2026-04-02T08:00:00.000Z",
      title: "Beta Room",
    });

    const status = await memoryStore.getAgentMemoryStatus(agentId, { backendId: "markdown" });
    const reindexResult = await memoryStore.reindexAgentMemory(agentId, { backendId: "markdown", force: true });

    assert.equal(status.backend, "sqlite-fts");
    assert.equal(status.hasTimeline, true);
    assert.equal(status.missingIndex, false);
    assert.equal(status.dirty, false);
    assert.ok((status.documentCount ?? 0) >= 1);
    assert.ok((status.chunkCount ?? 0) >= 1);
    assert.match(status.fallbackReason ?? "", /structured LCM memory/i);

    assert.equal(reindexResult.backend, "sqlite-fts");
    assert.equal(reindexResult.mode, "full");
    assert.ok(reindexResult.indexedDocuments >= 1);
    assert.ok((reindexResult.chunkCount ?? 0) >= 1);
    assert.match(reindexResult.fallbackReason ?? "", /structured LCM memory/i);
  });
});

test("agent memory search falls back to split-term recall for CJK-heavy queries", async () => {
  await withModules(async ({ memoryStore, lcmFacade }) => {
    const agentId = "harbor-concierge";
    await lcmFacade.appendAgentLcmMessage({
      agentId,
      role: "user",
      content: "请整理 B站 热门视频 的观察结论。",
      createdAt: "2026-04-02T09:00:00.000Z",
      title: "Harbor Room",
    });
    await lcmFacade.appendAgentLcmMessage({
      agentId,
      role: "assistant",
      content: "关键词建议聚焦在 热门视频、封面、标题 和 B站 推荐流。",
      createdAt: "2026-04-02T09:01:00.000Z",
      title: "Harbor Room",
    });

    const results = await memoryStore.searchAgentMemory(agentId, "B站 热门视频 关键词 B站", {
      maxResults: 10,
      minScore: 1,
    });

    assert.ok(results.length >= 1);
    assert.ok(results.some((result) => (result.snippet ?? "").includes("热门视频") || (result.snippet ?? "").includes("关键词")));
    assert.ok(results.every((result) => (result.score ?? 0) >= 1));
  });
});
