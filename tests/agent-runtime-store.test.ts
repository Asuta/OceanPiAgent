import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type RuntimeStoreModule = typeof import("../src/lib/server/agent-runtime-store");
type AgentCompactionModule = typeof import("../src/lib/server/agent-compaction");
type ModelConfigStoreModule = typeof import("../src/lib/server/model-config-store");
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
  run: (
    runtimeStore: RuntimeStoreModule,
    agentCompaction: AgentCompactionModule,
    workspaceStore: WorkspaceStoreModule,
    tempDir: string,
    modelConfigStore: ModelConfigStoreModule,
  ) => Promise<void>,
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-agent-runtime-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  const runtimeStoreUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-runtime-store.ts")).href;
  const agentCompactionUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-compaction.ts")).href;
  const workspaceStoreUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/workspace-store.ts")).href;
  const modelConfigStoreUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/model-config-store.ts")).href;

  try {
    const [runtimeStore, agentCompaction, workspaceStore, modelConfigStore] = await Promise.all([
      import(`${runtimeStoreUrl}?test=${Date.now()}-${Math.random()}`) as Promise<RuntimeStoreModule>,
      import(`${agentCompactionUrl}?test=${Date.now()}-${Math.random()}`) as Promise<AgentCompactionModule>,
      import(`${workspaceStoreUrl}?test=${Date.now()}-${Math.random()}`) as Promise<WorkspaceStoreModule>,
      import(`${modelConfigStoreUrl}?test=${Date.now()}-${Math.random()}`) as Promise<ModelConfigStoreModule>,
    ]);
    await run(runtimeStore, agentCompaction, workspaceStore, tempDir, modelConfigStore);
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
  patch: {
    compactionTokenThreshold?: number;
    compactionFreshTailCount?: number;
    systemPrompt?: string;
    modelConfigId?: string | null;
  },
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

test("compactPersistedAgentRuntime uses the current agent model config for compaction summaries", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore, _tempDir, modelConfigStore) => {
    const agentId = "concierge";
    const structuredSummary = [
      "## 关键结论",
      "- 当前 agent 配置应该驱动压缩摘要模型。",
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
      "- room-alpha",
    ].join("\n");
    let capturedArgs:
      | {
          resolvedModel: string;
          settings?: {
            modelConfigId: string | null;
            apiFormat: string;
            model: string;
            providerMode: string;
          };
          modelConfigOverrides?: {
            baseUrl?: string;
            apiKey?: string;
          };
        }
      | undefined;

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async (args) => {
      capturedArgs = {
        resolvedModel: args.resolvedModel,
        settings: args.settings
          ? {
              modelConfigId: args.settings.modelConfigId,
              apiFormat: args.settings.apiFormat,
              model: args.settings.model,
              providerMode: args.settings.providerMode,
            }
          : undefined,
        modelConfigOverrides: args.modelConfigOverrides,
      };
      return structuredSummary;
    });

    const modelConfig = await modelConfigStore.createModelConfig({
      name: "Compaction Summary Model",
      kind: "openai_compatible",
      model: "custom-compaction-model",
      apiFormat: "responses",
      baseUrl: "https://example.test/v1",
      providerMode: "generic",
      apiKey: "summary-key",
    });

    await setAgentCompactionSettings(workspaceStore, agentId, {
      compactionFreshTailCount: 0,
      modelConfigId: modelConfig.id,
    });
    await seedConversation(runtimeStore, agentId);

    const runtime = await runtimeStore.loadPersistedAgentRuntime(agentId);
    await runtimeStore.savePersistedAgentRuntime({
      ...runtime,
      resolvedModel: "right_codes/RightCode",
    });

    const result = await runtimeStore.compactPersistedAgentRuntime({
      agentId,
      reason: "manual",
      force: true,
    });

    assert.equal(result.compacted, true);
    assert.ok(capturedArgs);
    assert.equal(capturedArgs?.resolvedModel, "right_codes/RightCode");
    assert.equal(capturedArgs?.settings?.modelConfigId, modelConfig.id);
    assert.equal(capturedArgs?.settings?.model, "custom-compaction-model");
    assert.equal(capturedArgs?.settings?.apiFormat, "responses");
    assert.equal(capturedArgs?.settings?.providerMode, "generic");
    assert.equal(capturedArgs?.modelConfigOverrides?.baseUrl, "https://example.test/v1");
    assert.equal(capturedArgs?.modelConfigOverrides?.apiKey, "summary-key");

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

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
    assert.equal(persisted.compactions.length >= 1, true);
    assert.equal(persisted.compactions.at(-1)?.summary, structuredSummary);
    assert.equal(persisted.compactions.at(-1)?.success, true);
    assert.equal(persisted.compactions.at(-1)?.method, "llm");
    assert.equal(typeof persisted.compactions.at(-1)?.createdSummaryId, "string");
    assert.equal(persisted.compactions.at(-1)?.details?.result, "compacted");
    assert.ok((persisted.compactions.at(-1)?.details?.totalEstimatedTokens ?? 0) > 0);

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

test("compactPersistedAgentRuntime records skipped post-turn checks when no compaction is needed", async () => {
  await withRuntimeModules(async (runtimeStore) => {
    const agentId = "concierge";
    await seedConversation(runtimeStore, agentId);

    const result = await runtimeStore.compactPersistedAgentRuntime({
      agentId,
      reason: "post_turn",
    });
    const persisted = await runtimeStore.loadPersistedAgentRuntime(agentId);

    assert.equal(result.compacted, false);
    assert.ok(persisted.compactions.length >= 1);
    assert.equal(persisted.compactions.at(-1)?.reason, "post_turn");
    assert.equal(persisted.compactions.at(-1)?.success, true);
    assert.equal(persisted.compactions.at(-1)?.actionTaken, false);
    assert.ok((persisted.compactions.at(-1)?.summary ?? "").includes("阈值"));
    assert.ok(["below_threshold", "no_eligible_leaf_chunk", "empty_context", "leaf_pass_failed", "no_condensation_candidate"].includes(persisted.compactions.at(-1)?.details?.result ?? ""));
  });
});

test("compactPersistedAgentRuntime includes system prompt overhead in post-turn checks", async () => {
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
      reason: "post_turn",
    });

    assert.equal(result.compacted, true);
    assert.equal((await runtimeStore.loadPersistedAgentRuntime(agentId)).compactions.at(-1)?.reason, "post_turn");

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

test("compactPromptHistoryAfterToolBatch compresses only the prefix before the latest tool batch", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore) => {
    const agentId = "concierge";
    const lcmFacadeUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/lcm/facade.ts")).href;
    const lcmFacade = await import(`${lcmFacadeUrl}?test=${Date.now()}-${Math.random()}`) as typeof import("../src/lib/server/lcm/facade");
    await setAgentCompactionSettings(workspaceStore, agentId, {
      compactionTokenThreshold: 1_000,
      compactionFreshTailCount: 0,
    });
    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async () => "## 关键结论\n- 已压缩 earlier context。\n\n## 待办事项\n- 无\n\n## 约束与规则\n- 无\n\n## 用户仍在等待的问题\n- 无\n\n## 精确标识符\n- 无");

    const result = await runtimeStore.compactPromptHistoryAfterToolBatch({
      agentId,
      requestId: "req-post-tool-prefix",
      resolvedModel: "fake-provider/fake-model",
      historyDelta: [
        {
          role: "user",
          content: "Earlier room request: " + "context ".repeat(220),
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Earlier answer: " + "details ".repeat(180) }],
          api: "responses",
          provider: "openai",
          model: "fake-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-1", name: "web_fetch", arguments: { url: "https://example.com" } }],
          api: "responses",
          provider: "openai",
          model: "fake-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 3,
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "web_fetch",
          content: [{ type: "text", text: "tool output " + "result ".repeat(140) }],
          isError: false,
          timestamp: 4,
        },
      ],
    });
    const persisted = await runtimeStore.loadPersistedAgentRuntime(agentId);

    assert.equal(result.compacted, true);
    assert.equal(result.keptStartIndex, 2);
    assert.match(result.summaryText ?? "", /^## 关键结论/m);
    assert.ok(persisted.compactions.some((record) => record.reason === "post_tool"));
    assert.equal(persisted.compactions.at(-1)?.details?.result, "compacted");
    assert.equal(typeof persisted.compactions.at(-1)?.createdSummaryId, "string");

    const described = await lcmFacade.getAgentLcmRetrieval(agentId)
      .then(({ retrieval }) => retrieval.describe(persisted.compactions.at(-1)?.createdSummaryId ?? ""));
    assert.equal(described?.type, "summary");
    assert.equal(described?.summary?.content, result.summaryText);

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("compactPromptHistoryAfterToolBatch reuses the same transient LCM conversation across repeated post-tool compactions", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore) => {
    const agentId = "concierge";
    const requestId = "req-incremental-post-tool";
    const lcmFacadeUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/lcm/facade.ts")).href;
    const lcmFacade = await import(`${lcmFacadeUrl}?test=${Date.now()}-${Math.random()}`) as typeof import("../src/lib/server/lcm/facade");
    let summaryRound = 0;

    await setAgentCompactionSettings(workspaceStore, agentId, {
      compactionTokenThreshold: 1_000,
      compactionFreshTailCount: 0,
    });
    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async () => {
      summaryRound += 1;
      return [
        "## 关键结论",
        `- 增量压缩轮次 ${summaryRound}。`,
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
        `- req:${requestId}:${summaryRound}`,
      ].join("\n");
    });

    const firstHistoryDelta = [
      {
        role: "user" as const,
        content: "Earlier room request: " + "context ".repeat(220),
        timestamp: 1,
      },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Earlier answer: " + "details ".repeat(180) }],
        api: "responses" as const,
        provider: "openai",
        model: "fake-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: 2,
      },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "tool-1", name: "web_fetch", arguments: { url: "https://example.com/1" } }],
        api: "responses" as const,
        provider: "openai",
        model: "fake-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse" as const,
        timestamp: 3,
      },
      {
        role: "toolResult" as const,
        toolCallId: "tool-1",
        toolName: "web_fetch",
        content: [{ type: "text" as const, text: "tool output " + "result ".repeat(140) }],
        isError: false,
        timestamp: 4,
      },
    ];

    const firstResult = await runtimeStore.compactPromptHistoryAfterToolBatch({
      agentId,
      requestId,
      resolvedModel: "fake-provider/fake-model",
      historyDelta: firstHistoryDelta,
    });

    assert.equal(firstResult.compacted, true);
    assert.ok(firstResult.summaryText);
    const firstSummaryId = firstResult.record?.createdSummaryId;
    assert.equal(typeof firstSummaryId, "string");
    const firstDescription = await lcmFacade.getAgentPostToolLcmConversation(agentId, requestId)
      .then(({ retrieval }) => retrieval.describe(firstSummaryId ?? ""));
    assert.equal(firstDescription?.type, "summary");

    const secondHistoryDelta = [
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: firstResult.summaryText ?? "" }],
        api: "responses" as const,
        provider: "openai",
        model: "fake-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: 2,
      },
      ...firstHistoryDelta.slice(firstResult.keptStartIndex),
      {
        role: "user" as const,
        content: "Follow-up request: " + "latest updates ".repeat(220),
        timestamp: 5,
      },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "tool-2", name: "web_fetch", arguments: { url: "https://example.com/2" } }],
        api: "responses" as const,
        provider: "openai",
        model: "fake-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse" as const,
        timestamp: 6,
      },
      {
        role: "toolResult" as const,
        toolCallId: "tool-2",
        toolName: "web_fetch",
        content: [{ type: "text" as const, text: "second tool output " + "evidence ".repeat(140) }],
        isError: false,
        timestamp: 7,
      },
    ];

    const secondResult = await runtimeStore.compactPromptHistoryAfterToolBatch({
      agentId,
      requestId,
      resolvedModel: "fake-provider/fake-model",
      historyDelta: secondHistoryDelta,
    });

    assert.equal(secondResult.compacted, true);
    assert.ok(secondResult.summaryText);
    assert.notEqual(secondResult.record?.createdSummaryId, firstSummaryId);
    const secondSummaryId = secondResult.record?.createdSummaryId;
    const secondDescription = await lcmFacade.getAgentPostToolLcmConversation(agentId, requestId)
      .then(({ retrieval }) => retrieval.describe(secondSummaryId ?? ""));
    assert.equal(secondDescription?.type, "summary");
    assert.equal(
      secondDescription?.summary?.conversationId,
      firstDescription?.summary?.conversationId,
    );

    await runtimeStore.clearPostToolCompactionRunState({ agentId, requestId });
    const clearedConversation = await lcmFacade.getAgentPostToolLcmConversation(agentId, requestId);
    assert.equal(clearedConversation.conversation, null);

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("compactPromptHistoryAfterToolBatch keeps incremental post-tool LCM state even when the next history delta is still uncompressed", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore) => {
    const agentId = "concierge";
    const requestId = "req-incremental-post-tool-raw-history";
    const lcmFacadeUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/lcm/facade.ts")).href;
    const lcmFacade = await import(`${lcmFacadeUrl}?test=${Date.now()}-${Math.random()}`) as typeof import("../src/lib/server/lcm/facade");
    let summaryRound = 0;

    await setAgentCompactionSettings(workspaceStore, agentId, {
      compactionTokenThreshold: 1_000,
      compactionFreshTailCount: 0,
    });
    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async () => {
      summaryRound += 1;
      return [
        "## 关键结论",
        `- 原始历史增量压缩轮次 ${summaryRound}。`,
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
        `- req:${requestId}:${summaryRound}`,
      ].join("\n");
    });

    const firstHistoryDelta = [
      {
        role: "user" as const,
        content: "Earlier room request: " + "context ".repeat(220),
        timestamp: 1,
      },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Earlier answer: " + "details ".repeat(180) }],
        api: "responses" as const,
        provider: "openai",
        model: "fake-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: 2,
      },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "tool-1", name: "web_fetch", arguments: { url: "https://example.com/1" } }],
        api: "responses" as const,
        provider: "openai",
        model: "fake-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse" as const,
        timestamp: 3,
      },
      {
        role: "toolResult" as const,
        toolCallId: "tool-1",
        toolName: "web_fetch",
        content: [{ type: "text" as const, text: "tool output " + "result ".repeat(140) }],
        isError: false,
        timestamp: 4,
      },
    ];

    const firstResult = await runtimeStore.compactPromptHistoryAfterToolBatch({
      agentId,
      requestId,
      resolvedModel: "fake-provider/fake-model",
      historyDelta: firstHistoryDelta,
    });

    assert.equal(firstResult.compacted, true);
    const firstSummaryId = firstResult.record?.createdSummaryId;
    assert.equal(typeof firstSummaryId, "string");
    const firstDescription = await lcmFacade.getAgentPostToolLcmConversation(agentId, requestId)
      .then(({ retrieval }) => retrieval.describe(firstSummaryId ?? ""));
    assert.equal(firstDescription?.type, "summary");

    const secondHistoryDelta = [
      ...firstHistoryDelta,
      {
        role: "user" as const,
        content: "Follow-up request: " + "latest updates ".repeat(220),
        timestamp: 5,
      },
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "tool-2", name: "web_fetch", arguments: { url: "https://example.com/2" } }],
        api: "responses" as const,
        provider: "openai",
        model: "fake-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse" as const,
        timestamp: 6,
      },
      {
        role: "toolResult" as const,
        toolCallId: "tool-2",
        toolName: "web_fetch",
        content: [{ type: "text" as const, text: "second tool output " + "evidence ".repeat(140) }],
        isError: false,
        timestamp: 7,
      },
    ];

    const secondResult = await runtimeStore.compactPromptHistoryAfterToolBatch({
      agentId,
      requestId,
      resolvedModel: "fake-provider/fake-model",
      historyDelta: secondHistoryDelta,
    });

    assert.equal(secondResult.compacted, true);
    assert.ok(secondResult.summaryText);
    assert.notEqual(secondResult.record?.createdSummaryId, firstSummaryId);
    const secondSummaryId = secondResult.record?.createdSummaryId;
    const secondDescription = await lcmFacade.getAgentPostToolLcmConversation(agentId, requestId)
      .then(({ retrieval }) => retrieval.describe(secondSummaryId ?? ""));
    assert.equal(secondDescription?.type, "summary");
    assert.equal(
      secondDescription?.summary?.conversationId,
      firstDescription?.summary?.conversationId,
    );

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("compactPromptHistoryAfterToolBatch preserves visible room deliveries from tool results in the compaction summary", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore) => {
    const agentId = "concierge";
    await setAgentCompactionSettings(workspaceStore, agentId, {
      compactionTokenThreshold: 1_000,
      compactionFreshTailCount: 0,
    });
    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async (args) =>
      agentCompaction.__testing.buildRuleBasedCompactionSummary(args.messages)
    );

    const result = await runtimeStore.compactPromptHistoryAfterToolBatch({
      agentId,
      requestId: "req-visible-room-delivery",
      resolvedModel: "fake-provider/fake-model",
      historyDelta: [
        {
          role: "user",
          content: "Earlier room request: " + "context ".repeat(220),
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-1", name: "send_message_to_room", arguments: { roomId: "room-1" } }],
          api: "responses",
          provider: "openai",
          model: "fake-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "send_message_to_room",
          content: [{ type: "text", text: "Sent a room message (progress/completed/non-final)." }],
          details: {
            toolEvent: {
              id: "tool-1",
              sequence: 1,
              toolName: "send_message_to_room",
              displayName: "Send Message To Room",
              inputSummary: "",
              inputText: "",
              resultPreview: "Sent a room message (progress/completed/non-final).",
              outputText: "Sent a room message (progress/completed/non-final).",
              status: "success",
              durationMs: 1,
              roomMessage: {
                roomId: "room-1",
                content: "I will check the latest update.",
                kind: "progress",
                status: "completed",
                final: false,
              },
            },
          },
          isError: false,
          timestamp: 3,
        },
        {
          role: "user",
          content: "Follow-up request: " + "latest updates ".repeat(220),
          timestamp: 4,
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-2", name: "web_fetch", arguments: { url: "https://example.com" } }],
          api: "responses",
          provider: "openai",
          model: "fake-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 5,
        },
        {
          role: "toolResult",
          toolCallId: "tool-2",
          toolName: "web_fetch",
          content: [{ type: "text", text: "fetched current result" }],
          isError: false,
          timestamp: 6,
        },
      ],
    });

    assert.equal(result.compacted, true);
    assert.match(result.summaryText ?? "", /已经发出到房间的内容：\n- to room room-1: \[progress \/ completed\] I will check the latest update\./);
    assert.match(result.summaryText ?? "", /值得保留的工具结论：\n- Send Message To Room: Sent a room message \(progress\/completed\/non-final\)\./);

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("compactPromptHistoryAfterToolBatch keeps only the latest open room request in the fallback summary", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore) => {
    const agentId = "concierge";
    await setAgentCompactionSettings(workspaceStore, agentId, {
      compactionTokenThreshold: 1_000,
      compactionFreshTailCount: 0,
    });
    agentCompaction.__testing.setGenerateCompactionSummaryOverride(async (args) =>
      agentCompaction.__testing.buildRuleBasedCompactionSummary(args.messages)
    );

    const result = await runtimeStore.compactPromptHistoryAfterToolBatch({
      agentId,
      requestId: "req-open-room-request",
      resolvedModel: "fake-provider/fake-model",
      historyDelta: [
        {
          role: "user",
          content: [
            "[Incoming Chat Room message]",
            "Room ID: room-a",
            "Room Title: Alpha Room",
            "Message ID: msg-a",
            "Sender ID: room-scheduler",
            "Sender Name: Room Scheduler",
            "Sender Role: system",
            "Visible room message:",
            "[Room scheduler sync packet]",
            "Latest messageId: msg-a",
            "Unseen messages:",
            "- You: Need Jackie Chan updates.",
          ].join("\n"),
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-1", name: "send_message_to_room", arguments: { roomId: "room-a" } }],
          api: "responses",
          provider: "openai",
          model: "fake-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "send_message_to_room",
          content: [{ type: "text", text: "Sent a room message (progress/completed/non-final)." }],
          details: {
            toolEvent: {
              id: "tool-1",
              sequence: 1,
              toolName: "send_message_to_room",
              displayName: "Send Message To Room",
              inputSummary: "",
              inputText: "",
              resultPreview: "Sent a room message (progress/completed/non-final).",
              outputText: "Sent a room message (progress/completed/non-final).",
              status: "success",
              durationMs: 1,
              roomMessage: {
                roomId: "room-a",
                content: "I will check the latest Jackie Chan updates.",
                kind: "progress",
                status: "completed",
                final: false,
              },
            },
          },
          isError: false,
          timestamp: 3,
        },
        {
          role: "user",
          content: [
            "[Incoming Chat Room message]",
            "Room ID: room-b",
            "Room Title: Beta Room",
            "Message ID: msg-b",
            "Sender ID: room-scheduler",
            "Sender Name: Room Scheduler",
            "Sender Role: system",
            "Visible room message:",
            "[Room scheduler sync packet]",
            "Latest messageId: msg-b",
            "Unseen messages:",
            "- You: Need Donnie Yen updates.",
          ].join("\n"),
          timestamp: 4,
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-2", name: "web_fetch", arguments: { url: "https://example.com" } }],
          api: "responses",
          provider: "openai",
          model: "fake-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 5,
        },
        {
          role: "toolResult",
          toolCallId: "tool-2",
          toolName: "web_fetch",
          content: [{ type: "text", text: "fetched current result" }],
          isError: false,
          timestamp: 6,
        },
      ],
    });

    const importantRequestsBlock = result.summaryText?.match(/重要历史请求：\n([\s\S]*?)\n\n已经发出到房间的内容：/)?.[1] ?? "";

    assert.equal(result.compacted, true);
    assert.match(importantRequestsBlock, /Need Donnie Yen updates\./);
    assert.doesNotMatch(importantRequestsBlock, /Need Jackie Chan updates\./);

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("compactPromptHistoryAfterToolBatch stops when the post-tool compaction signal aborts", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore) => {
    const agentId = "concierge";
    await setAgentCompactionSettings(workspaceStore, agentId, {
      compactionTokenThreshold: 1_000,
      compactionFreshTailCount: 0,
    });

    agentCompaction.__testing.setGenerateCompactionSummaryOverride((args) => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve("too slow"), 1_000);
      args.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }, { once: true });
    }));

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(new Error("post-tool timeout")), 10);
    const result = await runtimeStore.compactPromptHistoryAfterToolBatch({
      agentId,
      requestId: "req-post-tool-abort",
      resolvedModel: "fake-provider/fake-model",
      signal: controller.signal,
      historyDelta: [
        {
          role: "user",
          content: "Earlier room request: " + "context ".repeat(220),
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-1", name: "web_fetch", arguments: { url: "https://example.com" } }],
          api: "responses",
          provider: "openai",
          model: "fake-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "web_fetch",
          content: [{ type: "text", text: "tool output " + "result ".repeat(140) }],
          isError: false,
          timestamp: 3,
        },
      ],
    });
    clearTimeout(abortTimer);

    assert.equal(result.compacted, false);
    assert.ok(result.record);
    assert.equal(result.record?.success, true);
    assert.equal(result.record?.reason, "post_tool");
    assert.equal(result.record?.details?.result, "aborted");
    assert.equal(result.record?.error, undefined);

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});

test("compactPromptHistoryAfterToolBatch keeps a completed post-tool compaction even if the timeout signal fires just before it returns", async () => {
  await withRuntimeModules(async (runtimeStore, agentCompaction, workspaceStore) => {
    const agentId = "concierge";
    await setAgentCompactionSettings(workspaceStore, agentId, {
      compactionTokenThreshold: 1_000,
      compactionFreshTailCount: 0,
    });

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(() => new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve([
          "## 关键结论",
          "- 压缩已经完成。",
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
          "- salvage:test",
        ].join("\n"));
      }, 25);
    }));

    const controller = new AbortController();
    const abortTimer = setTimeout(() => {
      controller.abort(new Error("Post-tool compaction timed out after 10 ms."));
    }, 10);

    const result = await runtimeStore.compactPromptHistoryAfterToolBatch({
      agentId,
      requestId: "req-post-tool-timeout-salvage",
      resolvedModel: "fake-provider/fake-model",
      signal: controller.signal,
      historyDelta: [
        {
          role: "user",
          content: "Earlier room request: " + "context ".repeat(220),
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-1", name: "web_fetch", arguments: { url: "https://example.com" } }],
          api: "responses",
          provider: "openai",
          model: "fake-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "web_fetch",
          content: [{ type: "text", text: "tool output " + "result ".repeat(140) }],
          isError: false,
          timestamp: 3,
        },
      ],
    });
    clearTimeout(abortTimer);

    assert.equal(result.compacted, true);
    assert.match(result.summaryText ?? "", /^## 关键结论/m);
    assert.equal(result.record?.details?.result, "compacted");
    assert.equal(typeof result.record?.createdSummaryId, "string");

    agentCompaction.__testing.setGenerateCompactionSummaryOverride(undefined);
  });
});
