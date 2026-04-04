import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type ModelConfigStoreModule = typeof import("../src/lib/server/model-config-store");

const repoRoot = process.cwd();

async function withTempCwd(run: (mod: ModelConfigStoreModule, tempDir: string) => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-model-config-store-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    const moduleUrl = pathToFileURL(path.join(repoRoot, "src/lib/server/model-config-store.ts")).href;
    const mod = (await import(`${moduleUrl}?test=${Date.now()}-${Math.random()}`)) as ModelConfigStoreModule;
    await run(mod, tempDir);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("model config store writes new configs to the root model-configs file", async () => {
  await withTempCwd(async (mod, tempDir) => {
    const created = await mod.createModelConfig({
      name: "DeepSeek",
      kind: "openai_compatible",
      model: "deepseek-chat",
      apiFormat: "responses",
      baseUrl: "https://api.deepseek.com",
      providerMode: "auto",
      apiKey: "sk-test",
    });

    const storedPath = path.join(tempDir, "model-configs.local.json");
    const stored = JSON.parse(await readFile(storedPath, "utf8")) as Array<Record<string, unknown>>;

    assert.equal(created.name, "DeepSeek");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.name, "DeepSeek");
    assert.equal(stored[0]?.apiKey, "sk-test");
  });
});

test("model config store carries legacy configs forward into the root model-configs file", async () => {
  await withTempCwd(async (mod, tempDir) => {
    const legacyDir = path.join(tempDir, ".oceanking", "model-configs");
    const legacyPath = path.join(legacyDir, "configs.json");
    const rootPath = path.join(tempDir, "model-configs.local.json");
    const legacyPayload = [
      {
        id: "legacy-config-1",
        name: "Legacy OpenAI",
        kind: "openai_compatible",
        model: "gpt-5.4",
        apiFormat: "responses",
        baseUrl: "https://api.openai.com/v1",
        providerMode: "auto",
        apiKey: "sk-legacy",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ];

    await mkdir(legacyDir, { recursive: true });
    await writeFile(legacyPath, JSON.stringify(legacyPayload, null, 2), "utf8");

    const listed = await mod.listModelConfigs();
    await mod.createModelConfig({
      name: "New Config",
      kind: "openai_compatible",
      model: "deepseek-chat",
      apiFormat: "chat_completions",
      baseUrl: "https://api.deepseek.com",
      providerMode: "auto",
      apiKey: "sk-new",
    });
    const migrated = JSON.parse(await readFile(rootPath, "utf8")) as Array<Record<string, unknown>>;

    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, "Legacy OpenAI");
    assert.equal(migrated.length, 2);
    assert.equal(migrated[0]?.id, "legacy-config-1");
    assert.equal(migrated[1]?.name, "New Config");
    await access(legacyPath);
  });
});
