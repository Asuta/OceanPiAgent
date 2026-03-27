import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeTool, getChatCompletionsTools, getResponsesTools } from "@/lib/ai/tools";

async function withTempCwd(run: (tempDir: string) => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-ai-tools-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    await run(tempDir);
  } finally {
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

test("tool registries expose the bash tool", () => {
  const chatTools = getChatCompletionsTools("default");
  const responseTools = getResponsesTools("default");

  assert(chatTools.some((tool) => tool.function.name === "bash"));
  assert(responseTools.some((tool) => tool.name === "bash"));
  assert(chatTools.some((tool) => tool.function.name === "skill_read"));
  assert(responseTools.some((tool) => tool.name === "project_context_read"));
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
  });
});

test("executeTool reports non-zero bash exits as errors", async () => {
  const result = await executeTool("bash", { command: "exit 7" });

  assert.equal(result.event.status, "error");
  assert.match(result.output, /Exit code: 7/);
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
