import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type AgentContextStoreModule = typeof import("../src/lib/server/agent-context-store");
type AgentContextAssemblerModule = typeof import("../src/lib/server/agent-context-assembler");
type AgentContextCompactionModule = typeof import("../src/lib/server/agent-context-compaction");
type AgentCompactionModule = typeof import("../src/lib/server/agent-compaction");

const repoRoot = process.cwd();

async function withAgentContextModules(
  run: (modules: {
    contextStore: AgentContextStoreModule;
    assembler: AgentContextAssemblerModule;
    contextCompaction: AgentContextCompactionModule;
    agentCompaction: AgentCompactionModule;
  }) => Promise<void>,
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-agent-context-compaction-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  const contextStoreUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-context-store.ts")).href;
  const assemblerUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-context-assembler.ts")).href;
  const contextCompactionUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-context-compaction.ts")).href;
  const agentCompactionUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-compaction.ts")).href;
  const querySuffix = `?test=${Date.now()}-${Math.random()}`;

  try {
    const [contextStore, assembler, contextCompaction, agentCompaction] = await Promise.all([
      import(`${contextStoreUrl}${querySuffix}`) as Promise<AgentContextStoreModule>,
      import(`${assemblerUrl}${querySuffix}`) as Promise<AgentContextAssemblerModule>,
      import(`${contextCompactionUrl}${querySuffix}`) as Promise<AgentContextCompactionModule>,
      import(`${agentCompactionUrl}${querySuffix}`) as Promise<AgentCompactionModule>,
    ]);
    await run({ contextStore, assembler, contextCompaction, agentCompaction });
    await contextStore.closeAgentContextStore();
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function appendMessage(
  contextStore: AgentContextStoreModule,
  args: {
    agentId: string;
    messageId: string;
    role: "user" | "assistant";
    source: "room_incoming" | "continuation_snapshot" | "room_run_completion";
    content: string;
    createdAt: string;
    roomId?: string;
  },
): Promise<void> {
  await contextStore.appendAgentContextMessage({
    agentId: args.agentId,
    messageId: args.messageId,
    role: args.role,
    source: args.source,
    content: args.content,
    createdAt: args.createdAt,
    roomId: args.roomId ?? "room-alpha",
    roomTitle: "Alpha Room",
    userMessageId: `${args.messageId}-room`,
    sender: {
      id: "user-1",
      name: "You",
      role: "participant",
    },
  });
}

test("compactAgentContext creates summary nodes and assembled history uses them", async () => {
  await withAgentContextModules(async ({ contextStore, assembler, contextCompaction, agentCompaction }) => {
    const agentId = "concierge";
    const summaryText = [
      "## Decisions",
      "- Rollout and rollback updates stay linked.",
      "",
      "## Open TODOs",
      "- Send the concise rollout summary.",
      "",
      "## Constraints/Rules",
      "- Keep cross-room context aligned.",
      "",
      "## Pending user asks",
      "- Provide the rollout update.",
      "",
      "## Exact identifiers",
      "- room-alpha",
    ].join("\n");
    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async () => summaryText);

    for (let index = 0; index < 10; index += 1) {
      await appendMessage(contextStore, {
        agentId,
        messageId: `msg-${index + 1}`,
        role: index % 2 === 0 ? "user" : "assistant",
        source: index % 2 === 0 ? "room_incoming" : "room_run_completion",
        content: `Context item ${index + 1} about rollout coordination and rollback planning.`,
        createdAt: `2026-04-01T10:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }

    const result = await contextCompaction.compactAgentContext({
      agentId,
      reason: "manual",
      force: true,
      resolvedModel: "gpt-test",
    });
    const state = await contextStore.getAgentContextStateSnapshot(agentId);
    const graph = await contextStore.exportAgentContextSummaryGraph(agentId);
    const assembled = await assembler.assembleAgentContextHistory({
      agentId,
      maxChars: 5_000,
    });

    assert.equal(result.compacted, true);
    assert.equal(result.summaryKind, "leaf");
    assert.ok(state);
    assert.equal(state?.items[0]?.itemType, "summary");
    assert.equal(state?.items[0]?.summary?.content, summaryText);
    assert.equal(graph?.summaries.length, 1);
    assert.equal(graph?.summaries[0]?.kind, "leaf");
    assert.equal(assembled[0]?.content, summaryText);
    assert.equal(assembled.length, state?.items.length);

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("assembleAgentContextHistory keeps the latest continuation snapshot even outside the recent tail", async () => {
  await withAgentContextModules(async ({ contextStore, assembler }) => {
    const agentId = "operator";
    await appendMessage(contextStore, {
      agentId,
      messageId: "msg-1",
      role: "user",
      source: "room_incoming",
      content: "First request for alpha room.",
      createdAt: "2026-04-01T11:00:00.000Z",
    });
    await appendMessage(contextStore, {
      agentId,
      messageId: "msg-2",
      role: "assistant",
      source: "continuation_snapshot",
      content: "[Continuation snapshot from an unfinished shared agent run] Keep alpha-room obligations active.",
      createdAt: "2026-04-01T11:01:00.000Z",
    });
    await appendMessage(contextStore, {
      agentId,
      messageId: "msg-3",
      role: "user",
      source: "room_incoming",
      content: "A separate beta-room update arrived.",
      createdAt: "2026-04-01T11:02:00.000Z",
      roomId: "room-beta",
    });
    await appendMessage(contextStore, {
      agentId,
      messageId: "msg-4",
      role: "assistant",
      source: "room_run_completion",
      content: "Prepared the beta-room update.",
      createdAt: "2026-04-01T11:03:00.000Z",
      roomId: "room-beta",
    });
    await appendMessage(contextStore, {
      agentId,
      messageId: "msg-5",
      role: "user",
      source: "room_incoming",
      content: "Need one more status check.",
      createdAt: "2026-04-01T11:04:00.000Z",
      roomId: "room-beta",
    });

    const assembled = await assembler.assembleAgentContextHistory({
      agentId,
      maxChars: 120,
      keepRecentItemCount: 2,
    });

    assert.ok(assembled.some((message) => message.content.includes("unfinished shared agent run")));
    assert.ok(assembled.some((message) => message.content.includes("Need one more status check")));
  });
});
