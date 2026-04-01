import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type AgentContextStoreModule = typeof import("../src/lib/server/agent-context-store");
type AgentMemoryRetrievalModule = typeof import("../src/lib/server/agent-memory-retrieval");

const repoRoot = process.cwd();

async function withMemoryRetrievalModules(
  run: (modules: {
    contextStore: AgentContextStoreModule;
    retrieval: AgentMemoryRetrievalModule;
    tempDir: string;
  }) => Promise<void>,
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-agent-memory-retrieval-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  const contextStoreUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-context-store.ts")).href;
  const retrievalUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-memory-retrieval.ts")).href;
  const querySuffix = `?test=${Date.now()}-${Math.random()}`;

  try {
    const [contextStore, retrieval] = await Promise.all([
      import(`${contextStoreUrl}${querySuffix}`) as Promise<AgentContextStoreModule>,
      import(`${retrievalUrl}${querySuffix}`) as Promise<AgentMemoryRetrievalModule>,
    ]);
    await run({ contextStore, retrieval, tempDir });
    await contextStore.closeAgentContextStore();
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("memory retrieval searches structured messages and summaries, then describes and expands summary handles", async () => {
  await withMemoryRetrievalModules(async ({ contextStore, retrieval }) => {
    const agentId = "concierge";
    await contextStore.appendAgentContextMessage({
      agentId,
      messageId: "msg-1",
      role: "user",
      source: "room_incoming",
      content: "Need the phoenix rollback plan.",
      createdAt: "2026-04-01T12:00:00.000Z",
      roomId: "room-alpha",
      roomTitle: "Alpha Room",
      userMessageId: "room-msg-1",
      sender: { id: "user-1", name: "You", role: "participant" },
      parts: [
        {
          partType: "incoming_room_envelope",
          textContent: "[Incoming Chat Room message]\nRoom ID: room-alpha\nVisible room message:\nNeed the phoenix rollback plan.",
        },
      ],
    });
    await contextStore.appendAgentContextMessage({
      agentId,
      messageId: "msg-2",
      role: "assistant",
      source: "room_run_completion",
      content: "Prepared the rollout response.",
      createdAt: "2026-04-01T12:01:00.000Z",
      roomId: "room-alpha",
      roomTitle: "Alpha Room",
      userMessageId: "room-msg-1",
      sender: { id: "user-1", name: "You", role: "participant" },
      parts: [
        {
          partType: "assistant_history_entry",
          textContent: "[Shared agent room action summary]\n\nTool results used:\n- workspace_read: phoenix rollback runbook loaded",
        },
      ],
    });
    await contextStore.insertAgentContextSummary({
      agentId,
      summaryId: "sum-leaf-1",
      kind: "leaf",
      depth: 0,
      content: [
        "## Decisions",
        "- Use the phoenix rollback runbook.",
        "",
        "## Open TODOs",
        "- Send the concise rollback answer.",
        "",
        "## Constraints/Rules",
        "- Keep the room reply short.",
        "",
        "## Pending user asks",
        "- Provide the phoenix rollback plan.",
        "",
        "## Exact identifiers",
        "- room-alpha",
      ].join("\n"),
      tokenCount: 80,
      messageIds: ["msg-1", "msg-2"],
      createdAt: "2026-04-01T12:02:00.000Z",
    });

    const searchResults = await retrieval.searchAgentMemoryUnified(agentId, "phoenix rollback", { maxResults: 5 });
    const messageHit = searchResults.find((result) => result.handle === "message:msg-1");
    const summaryHit = searchResults.find((result) => result.handle === "summary:sum-leaf-1");
    const summaryDescription = await retrieval.describeAgentMemoryHandle(agentId, "summary:sum-leaf-1");
    const expandedSummary = await retrieval.expandAgentMemoryHandle({
      agentId,
      handle: "summary:sum-leaf-1",
      depth: 1,
      includeMessages: true,
      maxItems: 10,
    });

    assert.ok(messageHit);
    assert.ok(summaryHit);
    assert.equal(summaryDescription?.type, "summary");
    assert.deepEqual(summaryDescription?.summary?.messageIds, ["msg-1", "msg-2"]);
    assert.equal(expandedSummary?.type, "summary");
    assert.ok(expandedSummary?.summaries.some((summary) => summary.summaryId === "sum-leaf-1"));
    assert.ok(expandedSummary?.messages.some((message) => message.messageId === "msg-1"));
    assert.ok(expandedSummary?.messages.some((message) => message.content.includes("phoenix rollback")));
  });
});

test("memory retrieval falls back to legacy markdown files for file handles and plain paths", async () => {
  await withMemoryRetrievalModules(async ({ retrieval, tempDir }) => {
    const agentId = "researcher";
    const memoryDir = path.join(tempDir, ".oceanking", "memory", agentId, "timeline");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      path.join(memoryDir, "2026-04.md"),
      "## 2026-04 shard\nlegacy phoenix rollback notes\noperator: ops\n",
      "utf8",
    );

    const searchResults = await retrieval.searchAgentMemoryUnified(agentId, "legacy phoenix rollback", { maxResults: 3 });
    const fileResult = searchResults.find((result) => result.handle === "file:timeline/2026-04.md");
    const fileDescription = await retrieval.describeAgentMemoryHandle(agentId, "file:timeline/2026-04.md");
    const fileRead = await retrieval.readAgentMemoryHandle({
      agentId,
      handleOrPath: "timeline/2026-04.md",
      from: 1,
      lines: 3,
    });

    assert.ok(fileResult);
    assert.equal(fileDescription?.type, "file");
    assert.match(fileDescription?.file?.text ?? "", /legacy phoenix rollback notes/);
    assert.equal("path" in (fileRead ?? {}), true);
    assert.match((fileRead as { text: string }).text, /legacy phoenix rollback notes/);
  });
});
