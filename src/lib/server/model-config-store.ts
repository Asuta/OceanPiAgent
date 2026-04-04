import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  ApiFormat,
  ChatSettings,
  ModelConfig,
  ModelConfigExecutionOverrides,
  ModelConfigKind,
  ProviderMode,
} from "@/lib/chat/types";

interface StoredModelConfigRecord {
  id: string;
  name: string;
  kind: ModelConfigKind;
  model: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  providerMode: ProviderMode;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfigMutationInput {
  name: string;
  kind: ModelConfigKind;
  model: string;
  apiFormat: ApiFormat;
  baseUrl?: string;
  providerMode?: ProviderMode;
  apiKey?: string;
  clearApiKey?: boolean;
}

const storedModelConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["openai_compatible", "pi_builtin"]),
  model: z.string(),
  apiFormat: z.enum(["chat_completions", "responses"]),
  baseUrl: z.string(),
  providerMode: z.enum(["auto", "openai", "right_codes", "generic"]),
  apiKey: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

const MODEL_CONFIG_FILE = path.join(process.cwd(), "model-configs.local.json");
const LEGACY_MODEL_CONFIG_FILE = path.join(process.cwd(), ".oceanking", "model-configs", "configs.json");

declare global {
  var __oceankingModelConfigWriteQueue: Promise<void> | undefined;
}

function createTimestamp(): string {
  return new Date().toISOString();
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function toPublicModelConfig(value: StoredModelConfigRecord): ModelConfig {
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    model: value.model,
    apiFormat: value.apiFormat,
    baseUrl: value.baseUrl,
    providerMode: value.providerMode,
    hasApiKey: Boolean(value.apiKey.trim()),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function normalizeStoredModelConfig(value: unknown): StoredModelConfigRecord | null {
  const parsed = storedModelConfigSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  return {
    ...parsed.data,
    name: parsed.data.name.trim(),
    model: parsed.data.model.trim(),
    baseUrl: normalizeBaseUrl(parsed.data.baseUrl),
    apiKey: parsed.data.apiKey.trim(),
  };
}

function normalizeInput(args: ModelConfigMutationInput, existing?: StoredModelConfigRecord): Omit<StoredModelConfigRecord, "id" | "createdAt" | "updatedAt"> {
  const kind = args.kind;
  const nextApiKey = args.clearApiKey ? "" : typeof args.apiKey === "string" ? args.apiKey.trim() : existing?.apiKey ?? "";

  if (kind === "pi_builtin") {
    return {
      name: args.name.trim(),
      kind,
      model: args.model.trim(),
      apiFormat: args.apiFormat,
      baseUrl: "",
      providerMode: "auto",
      apiKey: "",
    };
  }

  return {
    name: args.name.trim(),
    kind,
    model: args.model.trim(),
    apiFormat: args.apiFormat,
    baseUrl: normalizeBaseUrl(args.baseUrl ?? existing?.baseUrl ?? ""),
    providerMode: args.providerMode ?? existing?.providerMode ?? "auto",
    apiKey: nextApiKey,
  };
}

async function withModelConfigWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.__oceankingModelConfigWriteQueue ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.__oceankingModelConfigWriteQueue = previous.then(() => current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function parseStoredModelConfigs(raw: string): StoredModelConfigRecord[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((entry) => normalizeStoredModelConfig(entry)).filter((entry): entry is StoredModelConfigRecord => Boolean(entry));
  } catch {
    return [];
  }
}

async function readStoredModelConfigs(): Promise<StoredModelConfigRecord[]> {
  const rootRaw = await readFile(MODEL_CONFIG_FILE, "utf8").catch(() => null);
  if (typeof rootRaw === "string") {
    return parseStoredModelConfigs(rootRaw);
  }

  const legacyRaw = await readFile(LEGACY_MODEL_CONFIG_FILE, "utf8").catch(() => null);
  if (typeof legacyRaw !== "string") {
    return [];
  }

  const legacyConfigs = parseStoredModelConfigs(legacyRaw);
  if (legacyConfigs.length > 0) {
    await writeStoredModelConfigs(legacyConfigs);
  }
  return legacyConfigs;
}

async function writeStoredModelConfigs(modelConfigs: StoredModelConfigRecord[]): Promise<void> {
  await writeFile(MODEL_CONFIG_FILE, JSON.stringify(modelConfigs, null, 2), "utf8");
}

export async function listModelConfigs(): Promise<ModelConfig[]> {
  const modelConfigs = await readStoredModelConfigs();
  return modelConfigs.map((modelConfig) => toPublicModelConfig(modelConfig));
}

export async function getModelConfigById(id: string): Promise<ModelConfig | null> {
  const modelConfigs = await readStoredModelConfigs();
  const modelConfig = modelConfigs.find((entry) => entry.id === id);
  return modelConfig ? toPublicModelConfig(modelConfig) : null;
}

async function getStoredModelConfigById(id: string): Promise<StoredModelConfigRecord | null> {
  const modelConfigs = await readStoredModelConfigs();
  return modelConfigs.find((entry) => entry.id === id) ?? null;
}

export async function createModelConfig(args: ModelConfigMutationInput): Promise<ModelConfig> {
  return withModelConfigWriteLock(async () => {
    const modelConfigs = await readStoredModelConfigs();
    const timestamp = createTimestamp();
    const nextRecord: StoredModelConfigRecord = {
      id: crypto.randomUUID(),
      ...normalizeInput(args),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    modelConfigs.push(nextRecord);
    await writeStoredModelConfigs(modelConfigs);
    return toPublicModelConfig(nextRecord);
  });
}

export async function updateModelConfig(id: string, args: ModelConfigMutationInput): Promise<ModelConfig | null> {
  return withModelConfigWriteLock(async () => {
    const modelConfigs = await readStoredModelConfigs();
    const index = modelConfigs.findIndex((entry) => entry.id === id);
    if (index < 0) {
      return null;
    }

    const current = modelConfigs[index];
    const nextRecord: StoredModelConfigRecord = {
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: createTimestamp(),
      ...normalizeInput(args, current),
    };
    modelConfigs[index] = nextRecord;
    await writeStoredModelConfigs(modelConfigs);
    return toPublicModelConfig(nextRecord);
  });
}

export async function deleteModelConfig(id: string): Promise<boolean> {
  return withModelConfigWriteLock(async () => {
    const modelConfigs = await readStoredModelConfigs();
    const nextModelConfigs = modelConfigs.filter((entry) => entry.id !== id);
    if (nextModelConfigs.length === modelConfigs.length) {
      return false;
    }

    await writeStoredModelConfigs(nextModelConfigs);
    return true;
  });
}

export async function resolveSettingsWithModelConfig(settings: ChatSettings): Promise<{
  settings: ChatSettings;
  modelConfig: ModelConfig | null;
  modelConfigOverrides?: ModelConfigExecutionOverrides;
}> {
  if (!settings.modelConfigId) {
    return {
      settings,
      modelConfig: null,
    };
  }

  const storedModelConfig = await getStoredModelConfigById(settings.modelConfigId);
  if (!storedModelConfig) {
    throw new Error(`Selected model config \"${settings.modelConfigId}\" was not found.`);
  }

  const nextSettings: ChatSettings = {
    ...settings,
    model: storedModelConfig.model,
    apiFormat: storedModelConfig.apiFormat,
    providerMode: storedModelConfig.providerMode,
  };

  return {
    settings: nextSettings,
    modelConfig: toPublicModelConfig(storedModelConfig),
    ...(storedModelConfig.kind === "openai_compatible"
      ? {
          modelConfigOverrides: {
            ...(storedModelConfig.baseUrl ? { baseUrl: storedModelConfig.baseUrl } : {}),
            ...(storedModelConfig.apiKey ? { apiKey: storedModelConfig.apiKey } : {}),
          },
        }
      : {}),
  };
}
