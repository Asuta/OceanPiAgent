import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type MemoryStoreModule = typeof import("../src/lib/server/agent-memory-store");

const repoRoot = process.cwd();

async function withMemoryModule(run: (memoryStore: MemoryStoreModule, tempDir: string) => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-agent-memory-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  const memoryStoreUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-memory-store.ts")).href;

  try {
    const memoryStore = await import(`${memoryStoreUrl}?test=${Date.now()}-${Math.random()}`) as MemoryStoreModule;
    await run(memoryStore, tempDir);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeMemoryFile(tempDir: string, agentId: string, relPath: string, content: string): Promise<void> {
  const filePath = path.join(tempDir, ".oceanking", "memory", agentId, relPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

test("agent memory uses monthly timeline shards and recent-first search fallback", async () => {
  await withMemoryModule(async (memoryStore, tempDir) => {
    const appendedAgentId = "concierge";
    const recentSearchAgentId = "researcher";
    const olderSearchAgentId = "operator";
    const shardName = `${new Date().toISOString().slice(0, 7)}.md`;

    await memoryStore.appendAgentTurnMemory({
      agentId: appendedAgentId,
      roomId: "room-alpha",
      roomTitle: "Alpha Room",
      userMessageId: "msg-1",
      senderName: "You",
      userContent: "Need a short update.",
      assistantContent: "Drafted a concise update.",
      tools: [],
      emittedMessages: [],
      resolvedModel: "gpt-test",
    });

    const timelinePath = path.join(tempDir, ".oceanking", "memory", appendedAgentId, "timeline", shardName);
    const legacyTimelinePath = path.join(tempDir, ".oceanking", "memory", appendedAgentId, "timeline.md");
    const timelineText = await readFile(timelinePath, "utf8");
    const legacyStats = await stat(legacyTimelinePath).catch(() => null);
    const summary = await memoryStore.getAgentMemorySummary(appendedAgentId);
    const slice = await memoryStore.readAgentMemoryFile({
      agentId: appendedAgentId,
      relPath: `timeline/${shardName}`,
      from: 1,
      lines: 12,
    });

    assert.match(timelineText, /## .*Alpha Room/);
    assert.match(timelineText, /### User message/);
    assert.equal(legacyStats, null);
    assert.equal(summary.hasTimeline, true);
    assert.equal(slice.path, `timeline/${shardName}`);
    assert.match(slice.text, /Need a short update\./);

    const matchingBlock = [
      "## 2026-03 shard",
      "project phoenix launch checklist",
      "owner: ops",
      "status: active",
      "notes: keep the result concise",
      "",
    ].join("\n");

    await writeMemoryFile(tempDir, recentSearchAgentId, "timeline/2025-12.md", matchingBlock.replace("2026-03", "2025-12"));
    await writeMemoryFile(tempDir, recentSearchAgentId, "timeline/2026-01.md", matchingBlock.replace("2026-03", "2026-01"));
    await writeMemoryFile(tempDir, recentSearchAgentId, "timeline/2026-02.md", matchingBlock.replace("2026-03", "2026-02"));
    await writeMemoryFile(tempDir, recentSearchAgentId, "timeline/2026-03.md", matchingBlock);

    const recentResults = await memoryStore.searchAgentMemory(recentSearchAgentId, "project phoenix", { maxResults: 1 });

    assert.equal(recentResults.length, 1);
    assert.equal(recentResults[0]?.path, "timeline/2026-03.md");

    await writeMemoryFile(tempDir, olderSearchAgentId, "timeline/2026-01.md", "## 2026-01 shard\nrollout notes only\n");
    await writeMemoryFile(tempDir, olderSearchAgentId, "timeline/2026-02.md", "## 2026-02 shard\nstaging notes only\n");
    await writeMemoryFile(tempDir, olderSearchAgentId, "timeline/2026-03.md", "## 2026-03 shard\nstatus update only\n");
    await writeMemoryFile(tempDir, olderSearchAgentId, "timeline/2025-12.md", "## 2025-12 shard\nlegacy phoenix rollback path\n");

    const olderResults = await memoryStore.searchAgentMemory(olderSearchAgentId, "phoenix rollback", { maxResults: 1 });

    assert.equal(olderResults.length, 1);
    assert.equal(olderResults[0]?.path, "timeline/2025-12.md");
  });
});

test("agent memory status and reindex expose sqlite-backed index state", async () => {
  await withMemoryModule(async (memoryStore) => {
    const agentId = "concierge";

    await memoryStore.appendAgentTurnMemory({
      agentId,
      roomId: "room-beta",
      roomTitle: "Beta Room",
      userMessageId: "msg-2",
      senderName: "You",
      userContent: "Track the phoenix launch handoff.",
      assistantContent: "Captured the handoff checklist.",
      tools: [],
      emittedMessages: [],
      resolvedModel: "gpt-test",
    });

    const status = await memoryStore.getAgentMemoryStatus(agentId);
    const reindexResult = await memoryStore.reindexAgentMemory(agentId, { force: true });
    const searchResults = await memoryStore.searchAgentMemory(agentId, "phoenix handoff", { maxResults: 2 });

    assert.equal(status.backend, "sqlite-fts");
    assert.equal(status.hasTimeline, true);
    assert.equal(status.missingIndex, false);
    assert.equal(status.dirty, false);
    assert.ok((status.documentCount ?? 0) >= 1);
    assert.ok((status.chunkCount ?? 0) >= 1);
    assert.ok(status.lastIndexedAt);

    assert.equal(reindexResult.backend, "sqlite-fts");
    assert.equal(reindexResult.mode, "full");
    assert.ok(reindexResult.indexedDocuments >= 1);
    assert.ok((reindexResult.chunkCount ?? 0) >= 1);

    assert.equal(searchResults.length > 0, true);
    assert.match(searchResults[0]?.snippet ?? "", /phoenix/i);
  });
});

test("agent memory can be queried through the markdown backend explicitly", async () => {
  await withMemoryModule(async (memoryStore) => {
    const agentId = "operator";

    await memoryStore.appendAgentTurnMemory({
      agentId,
      roomId: "room-gamma",
      roomTitle: "Gamma Room",
      userMessageId: "msg-3",
      senderName: "You",
      userContent: "Remember the vendor retry window.",
      assistantContent: "Captured the vendor retry note.",
      tools: [],
      emittedMessages: [],
      resolvedModel: "gpt-test",
    });

    const status = await memoryStore.getAgentMemoryStatus(agentId, { backendId: "markdown" });
    const reindexResult = await memoryStore.reindexAgentMemory(agentId, { backendId: "markdown", force: true });
    const searchResults = await memoryStore.searchAgentMemory(agentId, "vendor retry", { backendId: "markdown", maxResults: 2 });

    assert.equal(status.backend, "markdown");
    assert.equal(status.missingIndex, false);
    assert.equal(reindexResult.backend, "markdown");
    assert.equal(searchResults.length > 0, true);
    assert.match(searchResults[0]?.snippet ?? "", /vendor retry/i);
  });
});
