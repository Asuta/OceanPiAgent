import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRoomBridgePrompt, buildSystemPrompt } from "@/lib/ai/system-prompt";
import { runBeforePromptBuildHooks } from "@/lib/ai/runtime-hooks";
import type { ChatSettings } from "@/lib/chat/types";

async function withTempCwd(run: (tempDir: string) => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-system-prompt-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    await run(tempDir);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}

function createSettings(overrides?: Partial<ChatSettings>): ChatSettings {
  return {
    modelConfigId: null,
    apiFormat: "responses",
    model: "",
    systemPrompt: "",
    providerMode: "auto",
    memoryBackend: "sqlite-fts",
    maxToolLoopSteps: 8,
    thinkingLevel: "off",
    enabledSkillIds: [],
    ...overrides,
  };
}

test("buildSystemPrompt advertises bash as a base tool", () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /bash, web_fetch, custom_command, skill_read, project_context_list, and project_context_read/);
  assert.match(prompt, /bash runs an unrestricted shell command on the server/);
  assert.match(prompt, /inspect it with memory_describe before relying on it/);
  assert.match(prompt, /use memory_expand before concluding/);
});

test("buildRoomBridgePrompt mentions bash for room agents", () => {
  const prompt = buildRoomBridgePrompt({
    roomTitle: "Test Room",
    roomId: "room-1",
    agentLabel: "Harbor Concierge",
  });

  assert.match(prompt, /base tools such as bash, web_fetch, custom_command, skill_read, project_context_list, and project_context_read/);
  assert.match(prompt, /bash runs on the server, not in the human-visible chat UI/);
  assert.match(prompt, /memory_describe/);
  assert.match(prompt, /memory_expand/);
});

test("buildRoomBridgePrompt requires early progress acknowledgments for multi-step room work", () => {
  const prompt = buildRoomBridgePrompt({
    roomTitle: "Test Room",
    roomId: "room-1",
    agentLabel: "Harbor Concierge",
  });

  assert.match(prompt, /send a brief send_message_to_room progress update early in the turn to acknowledge receipt and state the immediate plan before doing the deeper work/);
  assert.match(prompt, /If the task can be answered immediately with one concise final room reply, you do not need a separate acknowledgment message first/);
});

test("buildRoomBridgePrompt explains how to stream one formal room bubble with messageKey", () => {
  const prompt = buildRoomBridgePrompt({
    roomTitle: "Test Room",
    roomId: "room-1",
    agentLabel: "Harbor Concierge",
  });

  assert.match(prompt, /reuse the same send_message_to_room\.messageKey across repeated calls for that one bubble/);
  assert.match(prompt, /send partial user-facing text with the same messageKey and status=streaming, then end that same bubble with status=completed/);
});

test("prompt hooks append a skill catalog and injected project context", async () => {
  await withTempCwd(async (tempDir) => {
    await mkdir(path.join(tempDir, "skills", "precision"), { recursive: true });
    await writeFile(
      path.join(tempDir, "skills", "precision", "SKILL.md"),
      "---\nname: precision\ndescription: Use when the answer needs verified detail from tools.\n---\n\n# Precision\n\nThis body line should only appear after the skill is explicitly read.\n",
      "utf8",
    );
    await writeFile(
      path.join(tempDir, "PROJECT_CONTEXT.md"),
      "# Project Context\n\nKeep room-visible output inside send_message_to_room.\n",
      "utf8",
    );
    await writeFile(
      path.join(tempDir, "AGENTS.md"),
      "# Agent Rules\n\nAlways keep visible room output explicit.\n",
      "utf8",
    );

    const prompt = await runBeforePromptBuildHooks({
      agentId: undefined,
      settings: createSettings({ enabledSkillIds: ["precision"] }),
      toolScope: "default",
      toolContext: undefined,
      systemPrompt: buildSystemPrompt(),
    });

    assert.match(prompt, /<available_skills>/);
    assert.match(prompt, /<id>precision<\/id>/);
    assert.match(prompt, /<name>precision<\/name>/);
    assert.match(prompt, /<description>Use when the answer needs verified detail from tools\.<\/description>/);
    assert.match(prompt, /Project context catalog:/);
    assert.match(prompt, /## AGENTS\.md/);
    assert.match(prompt, /Always keep visible room output explicit\./);
    assert.match(prompt, /## PROJECT_CONTEXT\.md/);
    assert.match(prompt, /send_message_to_room/);
    assert.doesNotMatch(prompt, /This body line should only appear after the skill is explicitly read\./);
  });
});
