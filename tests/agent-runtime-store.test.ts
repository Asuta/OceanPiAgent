import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type RuntimeStoreModule = typeof import("../src/lib/server/agent-runtime-store");
type AgentCompactionModule = typeof import("../src/lib/server/agent-compaction");

const TEST_IMAGE_ATTACHMENT = {
  id: "img-1",
  kind: "image" as const,
  mimeType: "image/jpeg",
  filename: "test.jpg",
  sizeBytes: 1234,
  storagePath: "images/test.jpg",
  url: "/api/uploads/image/images/test.jpg",
};

const repoRoot = process.cwd();

async function withRuntimeModules(
  run: (runtimeStore: RuntimeStoreModule, agentCompaction: AgentCompactionModule, tempDir: string) => Promise<void>,
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-agent-runtime-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  const runtimeStoreUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-runtime-store.ts")).href;
  const agentCompactionUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-compaction.ts")).href;

  try {
    const [runtimeStore, agentCompaction] = await Promise.all([
      import(`${runtimeStoreUrl}?test=${Date.now()}-${Math.random()}`) as Promise<RuntimeStoreModule>,
      import(`${agentCompactionUrl}?test=${Date.now()}-${Math.random()}`) as Promise<AgentCompactionModule>,
    ]);
    await run(runtimeStore, agentCompaction, tempDir);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function seedConversation(runtimeStore: RuntimeStoreModule, agentId: "concierge" | "researcher" | "operator") {
  await runtimeStore.appendPersistedHistoryMessage({
    agentId,
    message: {
      role: "user",
      content: [
        "[Incoming Chat Room message]",
        "Room ID: room-alpha",
        "Room Title: Alpha Room",
        "Message ID: msg-1",
        "Sender ID: local-user",
        "Sender Name: You",
        "Sender Role: participant",
        "Visible room message:",
        "Need a short update on the deployment plan.",
      ].join("\n"),
    },
  });
  await runtimeStore.appendPersistedHistoryMessage({
    agentId,
    message: {
      role: "assistant",
      content: [
        "[Shared agent room action summary]",
        "",
        "Visible room deliveries:",
        "- to room room-alpha: [answer / completed / final] I will review the deployment plan.",
        "",
        "Tool results used:",
        "- workspace_read: deployment notes loaded",
      ].join("\n"),
    },
  });
  await runtimeStore.appendPersistedHistoryMessage({
    agentId,
    message: {
      role: "user",
      content: [
        "[Incoming Chat Room message]",
        "Room ID: room-alpha",
        "Room Title: Alpha Room",
        "Message ID: msg-2",
        "Sender ID: local-user",
        "Sender Name: You",
        "Sender Role: participant",
        "Visible room message:",
        "Also note the rollback path if staging fails.",
      ].join("\n"),
    },
  });
  await runtimeStore.appendPersistedHistoryMessage({
    agentId,
    message: {
      role: "assistant",
      content: [
        "[Shared agent room action summary]",
        "",
        "Visible room deliveries:",
        "- to room room-alpha: [progress / completed] Capturing rollout and rollback steps.",
        "",
        "Room actions:",
        "- read_no_reply for room room-alpha, message msg-2",
      ].join("\n"),
    },
  });
}

test("compactPersistedAgentRuntime stores an LLM-style structured summary when available", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction) => {
    const agentId = "concierge";
    const structuredSummary = [
      "## Decisions",
      "- Deployment update should include rollout and rollback status.",
      "",
      "## Open TODOs",
      "- Confirm the final rollback owner.",
      "",
      "## Constraints/Rules",
      "- Keep the room reply short.",
      "",
      "## Pending user asks",
      "- Provide a short deployment-plan update.",
      "",
      "## Exact identifiers",
      "- room-alpha",
      "- msg-1",
      "- msg-2",
    ].join("\n");

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async () => structuredSummary);
    await seedConversation(runtimeStore, agentId);

    const result = await runtimeStore.compactPersistedAgentRuntime({
      agentId,
      reason: "manual",
      force: true,
    });
    const persisted = await runtimeStore.loadPersistedAgentRuntime(agentId);

    assert.equal(result.compacted, true);
    assert.equal(result.history[0]?.role, "assistant");
    assert.equal(result.history[0]?.content, structuredSummary);
    assert.equal(result.history.length >= 1, true);
    assert.equal(persisted.compactions.length, 1);
    assert.equal(persisted.compactions[0]?.summary, structuredSummary);

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("compactPersistedAgentRuntime falls back to the local rule summary when LLM compaction fails", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction) => {
    const agentId = "researcher";
    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async () => {
      throw new Error("Synthetic compaction failure");
    });
    await seedConversation(runtimeStore, agentId);

    const result = await runtimeStore.compactPersistedAgentRuntime({
      agentId,
      reason: "manual",
      force: true,
    });

    assert.equal(result.compacted, true);
    assert.match(result.history[0]?.content ?? "", /^## Decisions/m);
    assert.match(result.history[0]?.content ?? "", /\[Compacted shared history summary\]/);
    assert.match(result.history[0]?.content ?? "", /^## Exact identifiers/m);

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("compactPersistedAgentRuntime keeps image-bearing messages in persisted history", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction) => {
    const agentId = "operator";
    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async () => {
      return [
        "## Decisions",
        "- none",
        "",
        "## Open TODOs",
        "- none",
        "",
        "## Constraints/Rules",
        "- none",
        "",
        "## Pending user asks",
        "- none",
        "",
        "## Exact identifiers",
        "- none",
      ].join("\n");
    });

    await seedConversation(runtimeStore, agentId);
    await runtimeStore.appendPersistedHistoryMessage({
      agentId,
      message: {
        role: "user",
        content: [
          "[Incoming Chat Room message]",
          "Room ID: room-alpha",
          "Room Title: Alpha Room",
          "Message ID: msg-image",
          "Sender ID: local-user",
          "Sender Name: You",
          "Sender Role: participant",
          "Visible room message:",
          "What is in this image?",
        ].join("\n"),
        attachments: [TEST_IMAGE_ATTACHMENT],
      },
    });

    const result = await runtimeStore.compactPersistedAgentRuntime({
      agentId,
      reason: "manual",
      force: true,
    });

    assert.equal(result.compacted, true);
    assert.match(result.history[0]?.content ?? "", /^## Decisions/m);
    assert.equal((await runtimeStore.loadPersistedAgentRuntime(agentId)).compactions.length, 1);

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});
