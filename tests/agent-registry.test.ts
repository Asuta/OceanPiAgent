import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { closeLcmDatabase } from "@/lib/server/lcm/db";

type AgentRegistryModule = typeof import("../src/lib/server/agent-registry");

const repoRoot = process.cwd();

async function withAgentRegistry(run: (mod: AgentRegistryModule, tempDir: string) => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-agent-registry-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    const moduleUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-registry.ts")).href;
    const mod = (await import(`${moduleUrl}?test=${Date.now()}-${Math.random()}`)) as AgentRegistryModule;
    await run(mod, tempDir);
  } finally {
    await closeLcmDatabase();
    process.chdir(previousCwd);
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(tempDir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (lastError) {
      throw lastError;
    }
  }
}

test("agent registry seeds built-in workspace-backed prompts", async () => {
  await withAgentRegistry(async (mod, tempDir) => {
    const agents = await mod.listAgentDefinitions();
    assert.deepEqual(agents.slice(0, 3).map((agent) => agent.id), ["concierge", "researcher", "operator"]);

    const promptPath = path.join(tempDir, ".oceanking", "workspaces", "concierge", ".agent", "system-prompt.md");
    const profilePath = path.join(tempDir, ".oceanking", "workspaces", "concierge", ".agent", "profile.json");
    const [prompt, profile] = await Promise.all([readFile(promptPath, "utf8"), readFile(profilePath, "utf8")]);

    assert.match(prompt, /Harbor Concierge/);
    assert.match(profile, /"label": "Harbor Concierge"/);
  });
});

test("agent registry creates and updates custom agents in their own workspaces", async () => {
  await withAgentRegistry(async (mod, tempDir) => {
    const created = await mod.createAgentDefinition({
      id: "market-watcher",
      label: "Market Watcher",
      summary: "Tracks market signals and reports changes.",
      skills: ["Research", "Alerts"],
      workingStyle: "Fast, evidence-backed, and concise.",
      instruction: "Prefer concrete signals and short summaries.",
    });

    assert.equal(created.id, "market-watcher");
    assert.equal(created.label, "Market Watcher");

    const updated = await mod.updateAgentDefinition("market-watcher", {
      summary: "Tracks signals, summarizes movement, and proposes next actions.",
      skills: ["Research", "Alerts", "Summaries"],
      instruction: "Lead with the most important market move.",
    });

    assert.equal(updated.summary, "Tracks signals, summarizes movement, and proposes next actions.");
    assert.deepEqual(updated.skills, ["Research", "Alerts", "Summaries"]);
    assert.equal(updated.instruction, "Lead with the most important market move.");

    const promptPath = path.join(tempDir, ".oceanking", "workspaces", "market-watcher", ".agent", "system-prompt.md");
    const profilePath = path.join(tempDir, ".oceanking", "workspaces", "market-watcher", ".agent", "profile.json");
    const [prompt, profile] = await Promise.all([readFile(promptPath, "utf8"), readFile(profilePath, "utf8")]);

    assert.match(prompt, /Lead with the most important market move/);
    assert.match(profile, /"label": "Market Watcher"/);
    assert.match(profile, /"summary": "Tracks signals, summarizes movement, and proposes next actions."/);
  });
});
