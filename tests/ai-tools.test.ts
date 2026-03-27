import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
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
