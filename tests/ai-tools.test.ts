import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
