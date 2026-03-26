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
