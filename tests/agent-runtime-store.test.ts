import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type RuntimeStoreModule = typeof import("../src/lib/server/agent-runtime-store");
type AgentCompactionModule = typeof import("../src/lib/server/agent-compaction");
type WorkspaceStoreModule = typeof import("../src/lib/server/workspace-store");

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
  run: (runtimeStore: RuntimeStoreModule, agentCompaction: AgentCompactionModule, workspaceStore: WorkspaceStoreModule, tempDir: string) => Promise<void>,
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-agent-runtime-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  const runtimeStoreUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-runtime-store.ts")).href;
  const agentCompactionUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-compaction.ts")).href;
  const workspaceStoreUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/workspace-store.ts")).href;

  try {
    const [runtimeStore, agentCompaction, workspaceStore] = await Promise.all([
      import(`${runtimeStoreUrl}?test=${Date.now()}-${Math.random()}`) as Promise<RuntimeStoreModule>,
      import(`${agentCompactionUrl}?test=${Date.now()}-${Math.random()}`) as Promise<AgentCompactionModule>,
      import(`${workspaceStoreUrl}?test=${Date.now()}-${Math.random()}`) as Promise<WorkspaceStoreModule>,
    ]);
    await run(runtimeStore, agentCompaction, workspaceStore, tempDir);
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

async function seedLongConversation(runtimeStore: RuntimeStoreModule, agentId: "concierge" | "researcher" | "operator", turns: number) {
  for (let index = 0; index < turns; index += 1) {
    const suffix = `${index + 1}`.padStart(2, "0");
    await runtimeStore.appendPersistedHistoryMessage({
      agentId,
      message: {
        role: "user",
        content: [
          "[Incoming Chat Room message]",
          `Room ID: room-long-${suffix}`,
          "Room Title: Long Room",
          `Message ID: msg-long-user-${suffix}`,
          "Sender ID: local-user",
          "Sender Name: You",
          "Sender Role: participant",
          "Visible room message:",
          `Long planning request ${suffix}: ${"deploy rollback checklist and escalation notes ".repeat(220)}`,
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
          `Visible room deliveries: - to room room-long-${suffix}: [answer / completed / final] ${"Acknowledged long planning context and captured action items. ".repeat(180)}`,
          "",
          `Tool results used: - workspace_read: ${"timeline evidence and follow-up references ".repeat(150)}`,
        ].join("\n"),
      },
    });
  }
}

async function setAgentCompactionSettings(
  workspaceStore: WorkspaceStoreModule,
  agentId: "concierge" | "researcher" | "operator",
  patch: { compactionTokenThreshold?: number; compactionFreshTailCount?: number; systemPrompt?: string },
) {
  const workspace = await workspaceStore.loadWorkspaceEnvelope();
  await workspaceStore.saveWorkspaceState({
    expectedVersion: workspace.version,
    state: {
      ...workspace.state,
      agentStates: {
        ...workspace.state.agentStates,
        [agentId]: {
          ...workspace.state.agentStates[agentId],
          settings: {
            ...workspace.state.agentStates[agentId]?.settings,
            ...patch,
          },
        },
      },
    },
  });
}

test("compactPersistedAgentRuntime stores an LLM-style structured summary when available", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore) => {
    const agentId = "concierge";
    const structuredSummary = [
      "## 关键结论",
      "- 部署更新需要同时包含发布状态和回滚状态。",
      "",
      "## 待办事项",
      "- 确认最终的回滚负责人。",
      "",
      "## 约束与规则",
      "- 房间内回复保持简短。",
      "",
      "## 用户仍在等待的问题",
      "- 提供一版简短的部署计划更新。",
      "",
      "## 精确标识符",
      "- room-alpha",
      "- msg-1",
      "- msg-2",
    ].join("\n");

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async () => structuredSummary);
    await setAgentCompactionSettings(workspaceStore, agentId, { compactionFreshTailCount: 0 });
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
    assert.equal(persisted.compactions[0]?.success, true);
    assert.equal(persisted.compactions[0]?.method, "llm");
    assert.equal(typeof persisted.compactions[0]?.createdSummaryId, "string");
    assert.equal(persisted.compactions[0]?.details?.result, "compacted");
    assert.ok((persisted.compactions[0]?.details?.totalEstimatedTokens ?? 0) > 0);

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("compactPersistedAgentRuntime falls back to the local rule summary when LLM compaction fails", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore) => {
    const agentId = "researcher";
    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async () => {
      throw new Error("Synthetic compaction failure");
    });
    await setAgentCompactionSettings(workspaceStore, agentId, { compactionFreshTailCount: 0 });
    await seedConversation(runtimeStore, agentId);

    const result = await runtimeStore.compactPersistedAgentRuntime({
      agentId,
      reason: "manual",
      force: true,
    });

    assert.equal(result.compacted, true);
    assert.match(result.history[0]?.content ?? "", /^## 关键结论/m);
    assert.match(result.history[0]?.content ?? "", /\[压缩后的共享历史摘要\]/);
    assert.match(result.history[0]?.content ?? "", /^## 精确标识符/m);
    assert.equal((await runtimeStore.loadPersistedAgentRuntime(agentId)).compactions[0]?.method, "rule_fallback");

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("compactPersistedAgentRuntime prunes image-bearing messages when they fall outside the kept window", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore) => {
    const agentId = "operator";
    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async () => {
      return [
        "## 关键结论",
        "- 无",
        "",
        "## 待办事项",
        "- 无",
        "",
        "## 约束与规则",
        "- 无",
        "",
        "## 用户仍在等待的问题",
        "- 无",
        "",
        "## 精确标识符",
        "- 无",
      ].join("\n");
    });

    await setAgentCompactionSettings(workspaceStore, agentId, { compactionFreshTailCount: 0 });
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
    await seedConversation(runtimeStore, agentId);

    const result = await runtimeStore.compactPersistedAgentRuntime({
      agentId,
      reason: "manual",
      force: true,
    });

    assert.equal(result.compacted, true);
    assert.match(result.history[0]?.content ?? "", /^## 关键结论/m);
    assert.equal((await runtimeStore.loadPersistedAgentRuntime(agentId)).compactions.length, 1);
    assert.ok(!result.history.some((message) => message.attachments.some((attachment) => attachment.id === TEST_IMAGE_ATTACHMENT.id)));

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("compactPersistedAgentRuntime records skipped automatic checks when no compaction is needed", async () => {
  await withRuntimeModules(async (runtimeStore) => {
    const agentId = "concierge";
    await seedConversation(runtimeStore, agentId);

    const result = await runtimeStore.compactPersistedAgentRuntime({
      agentId,
      reason: "automatic",
    });
    const persisted = await runtimeStore.loadPersistedAgentRuntime(agentId);

    assert.equal(result.compacted, false);
    assert.equal(persisted.compactions.length, 1);
    assert.equal(persisted.compactions[0]?.reason, "automatic");
    assert.equal(persisted.compactions[0]?.success, true);
    assert.equal(persisted.compactions[0]?.actionTaken, false);
    assert.ok((persisted.compactions[0]?.summary ?? "").includes("阈值"));
    assert.ok(["below_threshold", "no_eligible_leaf_chunk", "empty_context", "leaf_pass_failed", "no_condensation_candidate"].includes(persisted.compactions[0]?.details?.result ?? ""));
  });
});

test("compactPersistedAgentRuntime includes system prompt overhead in automatic checks", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore) => {
    const agentId = "concierge";
    await setAgentCompactionSettings(workspaceStore, agentId, {
      compactionTokenThreshold: 2_200,
      systemPrompt: "System policy ".repeat(900),
    });
    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async () => "## 关键结论\n- 因为完整请求超过阈值，所以执行压缩。\n\n## 待办事项\n- 无\n\n## 约束与规则\n- 无\n\n## 用户仍在等待的问题\n- 无\n\n## 精确标识符\n- 无");
    await seedConversation(runtimeStore, agentId);
    await seedConversation(runtimeStore, agentId);
    await seedConversation(runtimeStore, agentId);

    const result = await runtimeStore.compactPersistedAgentRuntime({
      agentId,
      reason: "automatic",
    });

    assert.equal(result.compacted, true);
    assert.equal((await runtimeStore.loadPersistedAgentRuntime(agentId)).compactions[0]?.reason, "automatic");

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("compactPersistedAgentRuntime allows fresh trail count to be set to zero", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore) => {
    const agentId = "concierge";
    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async () => "## 关键结论\n- 无\n\n## 待办事项\n- 无\n\n## 约束与规则\n- 无\n\n## 用户仍在等待的问题\n- 无\n\n## 精确标识符\n- 无");
    await setAgentCompactionSettings(workspaceStore, agentId, { compactionFreshTailCount: 0 });
    await seedConversation(runtimeStore, agentId);

    const result = await runtimeStore.compactPersistedAgentRuntime({
      agentId,
      reason: "manual",
      force: true,
    });

    assert.equal(result.compacted, true);
    assert.equal(result.history.length, 1);

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("compactPersistedAgentRuntime keeps compressing raw history after crossing the threshold", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore) => {
    const agentId = "operator";
    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async () => "## 关键结论\n- 长历史已被持续压缩。\n\n## 待办事项\n- 无\n\n## 约束与规则\n- 无\n\n## 用户仍在等待的问题\n- 无\n\n## 精确标识符\n- 无");
    await setAgentCompactionSettings(workspaceStore, agentId, {
      compactionFreshTailCount: 0,
      compactionTokenThreshold: 20_000,
    });
    await seedLongConversation(runtimeStore, agentId, 12);

    const result = await runtimeStore.compactPersistedAgentRuntime({
      agentId,
      reason: "manual",
      force: true,
    });

    assert.equal(result.compacted, true);
    assert.ok(result.history.length >= 1);
    assert.ok(
      result.history.every(
        (message) =>
          !message.content.includes("[Incoming Chat Room message]")
          && !message.content.includes("[Shared agent room action summary]"),
      ),
    );

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});
