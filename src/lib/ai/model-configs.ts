import { getPiProviderForModelValue } from "./pi-model-catalog";
import type { ChatSettings, ModelConfig, ModelConfigKind } from "@/lib/chat/types";

export function detectModelConfigKind(modelValue: string): ModelConfigKind {
  return getPiProviderForModelValue(modelValue) === "openai-compatible" ? "openai_compatible" : "pi_builtin";
}

export function applyModelConfigToSettings<T extends Pick<ModelConfig, "id" | "model" | "apiFormat" | "providerMode">>(
  settings: ChatSettings,
  modelConfig: T,
): ChatSettings {
  return {
    ...settings,
    modelConfigId: modelConfig.id,
    model: modelConfig.model,
    apiFormat: modelConfig.apiFormat,
    providerMode: modelConfig.providerMode,
  };
}

export function buildLegacyModelConfigSeed(settings: ChatSettings, fallbackName: string) {
  if (!settings.model.trim()) {
    return null;
  }

  return {
    name: fallbackName,
    kind: detectModelConfigKind(settings.model),
    model: settings.model,
    apiFormat: settings.apiFormat,
    baseUrl: "",
    providerMode: settings.providerMode,
  };
}

export function getModelConfigKindLabel(kind: ModelConfigKind): string {
  return kind === "openai_compatible" ? "OpenAI-Compatible" : "Pi Native";
}

export function getModelConfigApiLabel(modelConfig: Pick<ModelConfig, "kind" | "apiFormat">): string {
  if (modelConfig.kind === "openai_compatible") {
    return modelConfig.apiFormat === "responses" ? "OpenAI Responses" : "OpenAI Chat Completions";
  }

  return "Pi Native Routing";
}

export function createEmptyModelConfigDraft(index = 1) {
  return {
    name: `Model Config ${index}`,
    kind: "openai_compatible" as const,
    model: "",
    apiFormat: "responses" as const,
    baseUrl: "",
    providerMode: "openai" as const,
    apiKey: "",
    clearApiKey: false,
  };
}
