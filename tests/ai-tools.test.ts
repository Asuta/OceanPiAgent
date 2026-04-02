import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatSettings, RoomToolContext } from "@/lib/chat/types";
import { executeTool, getChatCompletionsTools, getResponsesTools } from "@/lib/ai/tools";
import { closeLcmDatabase } from "@/lib/server/lcm/db";

async function withTempCwd(run: (tempDir: string) => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-ai-tools-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    await run(tempDir);
  } finally {
    await closeLcmDatabase();
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}

function quoteExecutableForShell(filePath: string): string {
  if (process.platform === "win32") {
    return `"${filePath.replaceAll('"', '""')}"`;
  }

  return `'${filePath.replaceAll("'", "'\\''")}'`;
}

function createRoomToolContext(agentId = "concierge", memoryBackend: ChatSettings["memoryBackend"] = "sqlite-fts"): { room: RoomToolContext } {
  return {
    room: {
      currentAgentId: agentId,
      currentRoomId: "room-1",
      currentSettings: {
        modelConfigId: null,
        apiFormat: "chat_completions",
        model: "",
        systemPrompt: "",
        providerMode: "auto",
        memoryBackend,
        maxToolLoopSteps: 6,
        thinkingLevel: "off",
        enabledSkillIds: [],
      },
      attachedRooms: [],
      knownAgents: [],
      roomHistoryById: {},
    },
  };
}

test("tool registries expose the bash tool", () => {
  const chatTools = getChatCompletionsTools("default");
  const responseTools = getResponsesTools("default");

  assert(chatTools.some((tool) => tool.function.name === "bash"));
  assert(responseTools.some((tool) => tool.name === "bash"));
  assert(chatTools.some((tool) => tool.function.name === "skill_read"));
  assert(responseTools.some((tool) => tool.name === "project_context_read"));
  const roomChatTools = getChatCompletionsTools("room");
  const roomResponseTools = getResponsesTools("room");
  assert(roomChatTools.some((tool) => tool.function.name === "memory_status"));
  assert(roomChatTools.some((tool) => tool.function.name === "memory_index"));
  assert(roomChatTools.some((tool) => tool.function.name === "memory_describe"));
  assert(roomChatTools.some((tool) => tool.function.name === "memory_expand"));
  assert(roomResponseTools.some((tool) => tool.name === "memory_status"));
  assert(roomResponseTools.some((tool) => tool.name === "memory_index"));
  assert(roomResponseTools.some((tool) => tool.name === "memory_describe"));
  assert(roomResponseTools.some((tool) => tool.name === "memory_expand"));
});

test("room tool registries hide internal room streaming helpers from the model", () => {
  const chatTools = getChatCompletionsTools("room");
  const responseTools = getResponsesTools("room");

  assert(chatTools.some((tool) => tool.function.name === "send_message_to_room"));
  assert(responseTools.some((tool) => tool.name === "send_message_to_room"));
  assert(chatTools.some((tool) => tool.function.name === "memory_describe"));
  assert(chatTools.some((tool) => tool.function.name === "memory_expand"));
  assert(responseTools.some((tool) => tool.name === "memory_describe"));
  assert(responseTools.some((tool) => tool.name === "memory_expand"));
  assert(!chatTools.some((tool) => tool.function.name === "begin_room_message_stream"));
  assert(!chatTools.some((tool) => tool.function.name === "finalize_room_message_stream"));
  assert(!responseTools.some((tool) => tool.name === "begin_room_message_stream"));
  assert(!responseTools.some((tool) => tool.name === "finalize_room_message_stream"));
});

test("room tool registries hide internal room streaming helpers from the model", () => {
  const chatTools = getChatCompletionsTools("room");
  const responseTools = getResponsesTools("room");

  assert(chatTools.some((tool) => tool.function.name === "send_message_to_room"));
  assert(responseTools.some((tool) => tool.name === "send_message_to_room"));
  assert(!chatTools.some((tool) => tool.function.name === "begin_room_message_stream"));
  assert(!chatTools.some((tool) => tool.function.name === "finalize_room_message_stream"));
  assert(!responseTools.some((tool) => tool.name === "begin_room_message_stream"));
  assert(!responseTools.some((tool) => tool.name === "finalize_room_message_stream"));
});

test("executeTool runs bash commands in the requested cwd", async () => {
  await withTempCwd(async (tempDir) => {
    await mkdir(path.join(tempDir, "nested"));
    const nodeExecutable = quoteExecutableForShell(process.execPath);
    const command = `${nodeExecutable} -e "process.stdout.write(process.cwd())"`;

    const result = await executeTool("bash", { command, cwd: "nested" });

    assert.equal(result.event.status, "success");
    assert.match(result.output, /Exit code: 0/);
    assert.match(result.output, new RegExp(path.join(tempDir, "nested").replace(/\\/g, "\\\\")));
    assert.equal(result.event.details?.exitCode, 0);
    assert.equal(result.event.details?.cwd, path.join(tempDir, "nested"));
  });
});

test("executeTool reports non-zero bash exits as errors", async () => {
  const result = await executeTool("bash", { command: "exit 7" });

  assert.equal(result.event.status, "error");
  assert.match(result.output, /Exit code: 7/);
  assert.equal(result.event.details?.exitCode, 7);
});

test("executeTool strips ansi output from bash results", async () => {
  const nodeExecutable = quoteExecutableForShell(process.execPath);
  const command = `${nodeExecutable} -e "process.stdout.write('\\u001b[31mred\\u001b[0m')"`;

  const result = await executeTool("bash", { command });

  assert.equal(result.event.status, "success");
  assert.match(result.output, /red/);
  assert.doesNotMatch(result.output, /\u001b\[/u);
});

test("executeTool truncates large bash output and saves full output to a temp file", async () => {
  const nodeExecutable = quoteExecutableForShell(process.execPath);
  const command = `${nodeExecutable} -e "for (let index = 0; index < 9000; index += 1) console.log('line-' + index.toString().padStart(4, '0'))"`;

  const result = await executeTool("bash", { command });

  assert.equal(result.event.status, "success");
  assert.equal(result.event.details?.truncated, true);
  assert.ok(result.event.details?.fullOutputPath);
  await stat(result.event.details.fullOutputPath);

  const savedOutput = await readFile(result.event.details.fullOutputPath, "utf-8");
  assert.match(savedOutput, /line-0000/);
  assert.match(savedOutput, /line-8999/);
  assert.doesNotMatch(result.output, /line-0000/);
  assert.match(result.output, /line-8999/);
});

test("executeTool reports timed out bash commands with details", async () => {
  const nodeExecutable = quoteExecutableForShell(process.execPath);
  const command = `${nodeExecutable} -e "setTimeout(() => process.stdout.write('done'), 2000)"`;

  const result = await executeTool("bash", { command, timeoutMs: 1000 });

  assert.equal(result.event.status, "error");
  assert.equal(result.event.details?.timedOut, true);
  assert.equal(result.event.details?.exitCode, null);
  assert.match(result.output, /Timed out after: 1000ms/);
});

test("executeTool reads a workspace skill by id", async () => {
  await withTempCwd(async (tempDir) => {
    await mkdir(path.join(tempDir, "skills", "alpha-skill"), { recursive: true });
    await writeFile(
      path.join(tempDir, "skills", "alpha-skill", "SKILL.md"),
      "---\nname: alpha-skill\ndescription: Use when precision matters most.\n---\n\n# Alpha Skill\n\nBody-only guidance lives here.\n",
      "utf8",
    );

    const result = await executeTool("skill_read", { skillId: "alpha-skill" });

    assert.equal(result.event.status, "success");
    assert.match(result.output, /"id": "alpha-skill"/);
    assert.match(result.output, /"name": "alpha-skill"/);
    assert.match(result.output, /Use when precision matters most\./);
    assert.match(result.output, /Body-only guidance lives here\./);
    assert.doesNotMatch(result.output, /---/);
  });
});

test("executeTool lists and reads project context files", async () => {
  await withTempCwd(async (tempDir) => {
    await writeFile(
      path.join(tempDir, "PROJECT_CONTEXT.md"),
      "# Project Context\n\nUse project notes first.\n",
      "utf8",
    );
    await writeFile(
      path.join(tempDir, "AGENTS.md"),
      "# Agent Rules\n\nKeep room output explicit.\n",
      "utf8",
    );
    await mkdir(path.join(tempDir, "docs"), { recursive: true });
    await writeFile(
      path.join(tempDir, "docs", "README.md"),
      "# Docs\n\nDetailed runtime notes live here.\n",
      "utf8",
    );

    const listResult = await executeTool("project_context_list", {});
    const readResult = await executeTool("project_context_read", { path: "PROJECT_CONTEXT.md" });

    assert.equal(listResult.event.status, "success");
    assert.match(listResult.output, /AGENTS\.md/);
    assert.match(listResult.output, /PROJECT_CONTEXT\.md/);
    assert.match(listResult.output, /docs\/README\.md/);

    assert.equal(readResult.event.status, "success");
    assert.match(readResult.output, /Use project notes first\./);
  });
});

test("executeTool exposes memory status and memory index for room agents", async () => {
  await withTempCwd(async () => {
    const context = createRoomToolContext("concierge", "markdown");

    const statusResult = await executeTool("memory_status", {}, "room", undefined, context);
    const indexResult = await executeTool("memory_index", { force: true }, "room", undefined, context);

    assert.equal(statusResult.event.status, "success");
    assert.match(statusResult.output, /"backend": "sqlite-fts"/);

    assert.equal(indexResult.event.status, "success");
    assert.match(indexResult.output, /"mode": "full"/);
    assert.match(indexResult.output, /"backend": "sqlite-fts"/);
  });
});
