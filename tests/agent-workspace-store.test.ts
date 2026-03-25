import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type WorkspaceModule = typeof import("../src/lib/server/agent-workspace-store");

const repoRoot = process.cwd();
const originalEnvValue = process.env.OCEANKING_AGENT_WORKSPACE_ALLOW_OUTSIDE;

function normalizeWorkspacePath(value: string): string {
  return value.replace(/\\/g, "/");
}

async function withWorkspaceModule(run: (mod: WorkspaceModule, tempDir: string) => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-workspace-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  process.env.OCEANKING_AGENT_WORKSPACE_ALLOW_OUTSIDE = "false";

  try {
    const moduleUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/agent-workspace-store.ts")).href;
    const mod = (await import(`${moduleUrl}?test=${Date.now()}-${Math.random()}`)) as WorkspaceModule;
    await run(mod, tempDir);
  } finally {
    process.chdir(previousCwd);
    if (typeof originalEnvValue === "undefined") {
      delete process.env.OCEANKING_AGENT_WORKSPACE_ALLOW_OUTSIDE;
    } else {
      process.env.OCEANKING_AGENT_WORKSPACE_ALLOW_OUTSIDE = originalEnvValue;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("workspace store supports write, append, read, list, move, mkdir, and delete", async () => {
  await withWorkspaceModule(async (mod) => {
    const agentId = "concierge";

    const mkdirResult = await mod.mkdirAgentWorkspace({
      agentId,
      path: "notes/daily",
    });
    assert.equal(normalizeWorkspacePath(mkdirResult.path), "notes/daily");
    assert.equal(mkdirResult.created, true);

    const writeResult = await mod.writeAgentWorkspaceFile({
      agentId,
      path: "notes/daily/today.txt",
      content: "alpha",
    });
    assert.equal(normalizeWorkspacePath(writeResult.path), "notes/daily/today.txt");
    assert.equal(writeResult.bytesWritten, Buffer.byteLength("alpha", "utf8"));

    const appendResult = await mod.appendAgentWorkspaceFile({
      agentId,
      path: "notes/daily/today.txt",
      content: "\nbeta",
    });
    assert.equal(appendResult.bytesAppended, Buffer.byteLength("\nbeta", "utf8"));

    const readResult = await mod.readAgentWorkspaceFile({
      agentId,
      path: "notes/daily/today.txt",
    });
    assert.equal(normalizeWorkspacePath(readResult.path), "notes/daily/today.txt");
    assert.equal(readResult.text, "alpha\nbeta");

    const listResult = await mod.listAgentWorkspace({
      agentId,
      recursive: true,
    });
    assert.equal(listResult.targetPath, ".");
    assert.deepEqual(
      listResult.entries.map((entry) => normalizeWorkspacePath(entry.path)),
      ["notes", "notes/daily", "notes/daily/today.txt"],
    );

    const moveResult = await mod.moveAgentWorkspaceEntry({
      agentId,
      fromPath: "notes/daily/today.txt",
      toPath: "archive/today.txt",
    });
    assert.equal(normalizeWorkspacePath(moveResult.fromPath), "notes/daily/today.txt");
    assert.equal(normalizeWorkspacePath(moveResult.toPath), "archive/today.txt");
    assert.equal(moveResult.movedType, "file");

    const movedReadResult = await mod.readAgentWorkspaceFile({
      agentId,
      path: "archive/today.txt",
    });
    assert.equal(movedReadResult.text, "alpha\nbeta");

    const deleteFileResult = await mod.deleteAgentWorkspaceEntry({
      agentId,
      path: "archive/today.txt",
    });
    assert.equal(deleteFileResult.deletedType, "file");

    const deleteDirResult = await mod.deleteAgentWorkspaceEntry({
      agentId,
      path: "notes",
      recursive: true,
    });
    assert.equal(deleteDirResult.deletedType, "directory");
    assert.equal(deleteDirResult.recursive, true);

    const workspaceRoot = mod.getAgentWorkspaceDir(agentId);
    assert.ok(workspaceRoot.endsWith(path.join(".oceanking", "workspaces", agentId)));

    const finalListResult = await mod.listAgentWorkspace({
      agentId,
      recursive: true,
    });
    assert.deepEqual(finalListResult.entries.map((entry) => normalizeWorkspacePath(entry.path)), ["archive"]);
  });
});

test("workspace store shares the same workspace across rooms for the same agent type", async () => {
  await withWorkspaceModule(async (mod) => {
    const agentId = "concierge";

    await mod.writeAgentWorkspaceFile({
      agentId,
      path: "notes/today.txt",
      content: "left room only",
    });

    const leftList = await mod.listAgentWorkspace({
      agentId,
      recursive: true,
    });
    const rightList = await mod.listAgentWorkspace({
      agentId,
      recursive: true,
    });

    assert.deepEqual(leftList.entries.map((entry) => normalizeWorkspacePath(entry.path)), ["notes", "notes/today.txt"]);
    assert.deepEqual(rightList.entries.map((entry) => normalizeWorkspacePath(entry.path)), ["notes", "notes/today.txt"]);
    assert.ok(mod.getAgentWorkspaceDir(agentId).endsWith(path.join(".oceanking", "workspaces", agentId)));
  });
});

test("shared workspace is visible across different agents without merging private workspaces", async () => {
  await withWorkspaceModule(async (mod) => {
    await mod.writeAgentWorkspaceFile({
      agentId: "concierge",
      path: "private/concierge.txt",
      content: "concierge only",
    });

    await mod.writeAgentWorkspaceFile({
      agentId: "researcher",
      path: "private/researcher.txt",
      content: "researcher only",
    });

    const sharedWrite = await mod.writeSharedWorkspaceFile({
      path: "handoffs/plan.md",
      content: "step 1",
    });
    assert.equal(normalizeWorkspacePath(sharedWrite.path), "handoffs/plan.md");
    assert.ok(sharedWrite.workspaceRoot.endsWith(path.join(".oceanking", "workspaces", "_shared")));

    const sharedAppend = await mod.appendSharedWorkspaceFile({
      path: "handoffs/plan.md",
      content: "\nstep 2",
    });
    assert.equal(sharedAppend.bytesAppended, Buffer.byteLength("\nstep 2", "utf8"));

    const sharedRead = await mod.readSharedWorkspaceFile({
      path: "handoffs/plan.md",
    });
    assert.equal(sharedRead.text, "step 1\nstep 2");

    const sharedList = await mod.listSharedWorkspace({
      recursive: true,
    });
    assert.deepEqual(sharedList.entries.map((entry) => normalizeWorkspacePath(entry.path)), ["handoffs", "handoffs/plan.md"]);

    const conciergeList = await mod.listAgentWorkspace({
      agentId: "concierge",
      recursive: true,
    });
    const researcherList = await mod.listAgentWorkspace({
      agentId: "researcher",
      recursive: true,
    });
    const conciergeEntries = conciergeList.entries.map((entry) => normalizeWorkspacePath(entry.path));
    const researcherEntries = researcherList.entries.map((entry) => normalizeWorkspacePath(entry.path));
    assert.ok(conciergeEntries.includes("private/concierge.txt"));
    assert.ok(!conciergeEntries.includes("private/researcher.txt"));
    assert.ok(researcherEntries.includes("private/researcher.txt"));
    assert.ok(!researcherEntries.includes("private/concierge.txt"));

    assert.ok(mod.getSharedWorkspaceDir().endsWith(path.join(".oceanking", "workspaces", "_shared")));
  });
});

test("workspace store blocks path traversal outside the agent workspace by default", async () => {
  await withWorkspaceModule(async (mod) => {
    await assert.rejects(
      mod.writeAgentWorkspaceFile({
        agentId: "researcher",
        path: "../escape.txt",
        content: "nope",
      }),
      /Workspace access is limited to the agent workspace root/,
    );
  });
});

test("workspace move rejects moving a directory into itself", async () => {
  await withWorkspaceModule(async (mod) => {
    const agentId = "operator";
    await mod.mkdirAgentWorkspace({
      agentId,
      path: "plans/current",
    });

    await assert.rejects(
      mod.moveAgentWorkspaceEntry({
        agentId,
        fromPath: "plans",
        toPath: "plans/current/nested",
      }),
      /Cannot move a workspace directory into itself/,
    );
  });
});
