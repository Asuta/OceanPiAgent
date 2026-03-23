import type { ApiFormat, ThinkingLevel } from "@/lib/chat/types";

export type PiProviderId =
  | "openai-compatible"
  | "openai"
  | "anthropic"
  | "google"
  | "groq"
  | "mistral"
  | "openrouter";

export interface PiProviderOption {
  id: PiProviderId;
  label: string;
  description: string;
  envHint: string;
  apiLabel: string;
  defaultModel: string;
  usesCustomEndpoint: boolean;
}

export interface PiModelOption {
  value: string;
  label: string;
  summary: string;
  reasoning: boolean;
  supportsXhigh: boolean;
}

interface PiProviderCatalogEntry extends PiProviderOption {
  models: PiModelOption[];
}

export interface PiThinkingCapability {
  reasoning: boolean;
  supportsXhigh: boolean;
  knownModel: boolean;
}

const PROVIDER_CATALOG: Record<PiProviderId, PiProviderCatalogEntry> = {
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-Compatible",
    description: "Use your current OPENAI_BASE_URL / OPENAI_API_KEY endpoint, including hosted OpenAI-compatible gateways.",
    envHint: "OPENAI_API_KEY + optional OPENAI_BASE_URL",
    apiLabel: "Configurable OpenAI API",
    defaultModel: "",
    usesCustomEndpoint: true,
    models: [
      {
        value: "",
        label: "Use OPENAI_MODEL",
        summary: "Leave the model empty and follow your environment default.",
        reasoning: false,
        supportsXhigh: false,
      },
      {
        value: "gpt-4.1-mini",
        label: "GPT-4.1 mini",
        summary: "Balanced default for fast room work on OpenAI-compatible endpoints.",
        reasoning: false,
        supportsXhigh: false,
      },
      {
        value: "gpt-4.1",
        label: "GPT-4.1",
        summary: "Higher-quality general model when your endpoint mirrors OpenAI naming.",
        reasoning: false,
        supportsXhigh: false,
      },
      {
        value: "gpt-5",
        label: "GPT-5",
        summary: "Reasoning-capable model for deeper planning and tool-heavy work.",
        reasoning: true,
        supportsXhigh: false,
      },
      {
        value: "gpt-5-mini",
        label: "GPT-5 mini",
        summary: "Cheaper reasoning-capable option when available on your endpoint.",
        reasoning: true,
        supportsXhigh: false,
      },
      {
        value: "o4-mini",
        label: "o4-mini",
        summary: "Compact reasoning model for OpenAI-compatible deployments that expose the o-series.",
        reasoning: true,
        supportsXhigh: false,
      },
    ],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    description: "Use pi-ai's native OpenAI provider instead of the generic compatibility layer.",
    envHint: "OPENAI_API_KEY",
    apiLabel: "OpenAI Responses",
    defaultModel: "openai/gpt-4.1-mini",
    usesCustomEndpoint: false,
    models: [
      {
        value: "openai/gpt-4.1-mini",
        label: "GPT-4.1 mini",
        summary: "Fast default for everyday room responses.",
        reasoning: false,
        supportsXhigh: false,
      },
      {
        value: "openai/gpt-4.1",
        label: "GPT-4.1",
        summary: "Higher quality general model for synthesis and multi-step tool usage.",
        reasoning: false,
        supportsXhigh: false,
      },
      {
        value: "openai/gpt-4o-mini",
        label: "GPT-4o mini",
        summary: "Budget-friendly multimodal OpenAI option.",
        reasoning: false,
        supportsXhigh: false,
      },
      {
        value: "openai/gpt-5",
        label: "GPT-5",
        summary: "Reasoning-first OpenAI model for harder room orchestration.",
        reasoning: true,
        supportsXhigh: false,
      },
      {
        value: "openai/gpt-5-mini",
        label: "GPT-5 mini",
        summary: "Faster reasoning variant with lower cost.",
        reasoning: true,
        supportsXhigh: false,
      },
    ],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    description: "Use Anthropic's native Messages API through pi-ai.",
    envHint: "ANTHROPIC_API_KEY",
    apiLabel: "Anthropic Messages",
    defaultModel: "anthropic/claude-sonnet-4-5",
    usesCustomEndpoint: false,
    models: [
      {
        value: "anthropic/claude-sonnet-4-5",
        label: "Claude Sonnet 4.5",
        summary: "Strong default for careful reasoning and polished writing.",
        reasoning: true,
        supportsXhigh: false,
      },
      {
        value: "anthropic/claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        summary: "Large context and reliable reasoning for room workflows.",
        reasoning: true,
        supportsXhigh: false,
      },
      {
        value: "anthropic/claude-opus-4-5",
        label: "Claude Opus 4.5",
        summary: "Premium Anthropic reasoning model for the hardest tasks.",
        reasoning: true,
        supportsXhigh: false,
      },
      {
        value: "anthropic/claude-opus-4-6",
        label: "Claude Opus 4.6",
        summary: "High-end long-context reasoning with xhigh support.",
        reasoning: true,
        supportsXhigh: true,
      },
    ],
  },
  google: {
    id: "google",
    label: "Google",
    description: "Use Gemini through pi-ai's native Google provider.",
    envHint: "GEMINI_API_KEY",
    apiLabel: "Google Generative AI",
    defaultModel: "google/gemini-2.5-flash-lite",
    usesCustomEndpoint: false,
    models: [
      {
        value: "google/gemini-2.5-flash-lite",
        label: "Gemini 2.5 Flash Lite",
        summary: "Fastest reasoning-capable Gemini option in the curated set.",
        reasoning: true,
        supportsXhigh: false,
      },
      {
        value: "google/gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
        summary: "Fast reasoning model with big context for research and routing.",
        reasoning: true,
        supportsXhigh: false,
      },
      {
        value: "google/gemini-2.5-pro",
        label: "Gemini 2.5 Pro",
        summary: "Higher-quality Gemini model for more complex room decisions.",
        reasoning: true,
        supportsXhigh: false,
      },
    ],
  },
  groq: {
    id: "groq",
    label: "Groq",
    description: "Use Groq's native OpenAI-compatible provider through pi-ai for very low latency.",
    envHint: "GROQ_API_KEY",
    apiLabel: "Groq Chat Completions",
    defaultModel: "groq/llama-3.3-70b-versatile",
    usesCustomEndpoint: false,
    models: [
      {
        value: "groq/llama-3.3-70b-versatile",
        label: "Llama 3.3 70B Versatile",
        summary: "Fast large open model for general room work.",
        reasoning: false,
        supportsXhigh: false,
      },
      {
        value: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
        label: "Llama 4 Scout 17B",
        summary: "Fast multimodal model for lightweight tool-driven tasks.",
        reasoning: false,
        supportsXhigh: false,
      },
      {
        value: "groq/deepseek-r1-distill-llama-70b",
        label: "DeepSeek R1 Distill Llama 70B",
        summary: "Reasoning-oriented Groq option for deliberate analysis.",
        reasoning: true,
        supportsXhigh: false,
      },
    ],
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    description: "Use pi-ai's native Mistral Conversations provider.",
    envHint: "MISTRAL_API_KEY",
    apiLabel: "Mistral Conversations",
    defaultModel: "mistral/devstral-medium-latest",
    usesCustomEndpoint: false,
    models: [
      {
        value: "mistral/devstral-medium-latest",
        label: "Devstral Medium",
        summary: "Code-and-operations friendly model with large context.",
        reasoning: false,
        supportsXhigh: false,
      },
      {
        value: "mistral/codestral-latest",
        label: "Codestral",
        summary: "Coding-focused Mistral option for structured tasks.",
        reasoning: false,
        supportsXhigh: false,
      },
      {
        value: "mistral/magistral-medium-latest",
        label: "Magistral Medium",
        summary: "Reasoning-enabled Mistral model for more deliberate problem solving.",
        reasoning: true,
        supportsXhigh: false,
      },
    ],
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    description: "Use pi-ai's native OpenRouter provider to route across multiple upstream vendors.",
    envHint: "OPENROUTER_API_KEY",
    apiLabel: "OpenRouter Chat Completions",
    defaultModel: "openrouter/openai/gpt-5",
    usesCustomEndpoint: false,
    models: [
      {
        value: "openrouter/openai/gpt-5",
        label: "OpenAI GPT-5",
        summary: "Reasoning-first OpenRouter route with broad ecosystem availability.",
        reasoning: true,
        supportsXhigh: false,
      },
      {
        value: "openrouter/anthropic/claude-3.7-sonnet",
        label: "Anthropic Claude 3.7 Sonnet",
        summary: "Reasoning-capable Sonnet route through OpenRouter.",
        reasoning: true,
        supportsXhigh: false,
      },
      {
        value: "openrouter/google/gemini-2.5-pro",
        label: "Google Gemini 2.5 Pro",
        summary: "High-context Gemini route through OpenRouter.",
        reasoning: true,
        supportsXhigh: false,
      },
      {
        value: "openrouter/openai/gpt-4o-mini",
        label: "OpenAI GPT-4o mini",
        summary: "Budget-friendly OpenRouter default when you do not need reasoning.",
        reasoning: false,
        supportsXhigh: false,
      },
    ],
  },
};

export const PI_PROVIDER_OPTIONS: PiProviderOption[] = Object.values(PROVIDER_CATALOG).map((provider) => ({
  id: provider.id,
  label: provider.label,
  description: provider.description,
  envHint: provider.envHint,
  apiLabel: provider.apiLabel,
  defaultModel: provider.defaultModel,
  usesCustomEndpoint: provider.usesCustomEndpoint,
}));

function normalizeModelValue(value: string): string {
  return value.trim();
}

function getProviderPrefix(modelValue: string): string | null {
  const normalized = normalizeModelValue(modelValue);
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0) {
    return null;
  }

  return normalized.slice(0, slashIndex);
}

export function getPiProviderOption(providerId: PiProviderId): PiProviderOption {
  const provider = PROVIDER_CATALOG[providerId];
  return {
    id: provider.id,
    label: provider.label,
    description: provider.description,
    envHint: provider.envHint,
    apiLabel: provider.apiLabel,
    defaultModel: provider.defaultModel,
    usesCustomEndpoint: provider.usesCustomEndpoint,
  };
}

export function getPiProviderOptions(): PiProviderOption[] {
  return PI_PROVIDER_OPTIONS;
}

export function getPiProviderForModelValue(modelValue: string): PiProviderId {
  const providerPrefix = getProviderPrefix(modelValue);
  if (!providerPrefix) {
    return "openai-compatible";
  }

  if (providerPrefix in PROVIDER_CATALOG && providerPrefix !== "openai-compatible") {
    return providerPrefix as PiProviderId;
  }

  return "openai-compatible";
}

export function getPiModelOptions(providerId: PiProviderId): PiModelOption[] {
  return PROVIDER_CATALOG[providerId].models;
}

export function getPiDefaultModelValue(providerId: PiProviderId): string {
  return PROVIDER_CATALOG[providerId].defaultModel;
}

export function getPiModelOptionByValue(modelValue: string): PiModelOption | null {
  const providerId = getPiProviderForModelValue(modelValue);
  return PROVIDER_CATALOG[providerId].models.find((model) => model.value === normalizeModelValue(modelValue)) ?? null;
}

export function getPiConfiguredApiLabel(modelValue: string, requestedApiFormat: ApiFormat): string {
  const providerId = getPiProviderForModelValue(modelValue);
  if (providerId === "openai-compatible") {
    return requestedApiFormat === "responses" ? "OpenAI Responses" : "OpenAI Chat Completions";
  }

  return PROVIDER_CATALOG[providerId].apiLabel;
}

export function getPiThinkingCapability(modelValue: string): PiThinkingCapability {
  const preset = getPiModelOptionByValue(modelValue);
  if (preset) {
    return {
      reasoning: preset.reasoning,
      supportsXhigh: preset.supportsXhigh,
      knownModel: true,
    };
  }

  const normalized = normalizeModelValue(modelValue).toLowerCase();
  if (!normalized) {
    return {
      reasoning: false,
      supportsXhigh: false,
      knownModel: false,
    };
  }

  const reasoning =
    normalized.startsWith("openai/gpt-5") ||
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized.includes("claude-sonnet-4") ||
    normalized.includes("claude-opus-4") ||
    normalized.includes("gemini-2.5") ||
    normalized.includes("deepseek-r1") ||
    normalized.includes("reason");
  const supportsXhigh =
    normalized.includes("gpt-5.2") ||
    normalized.includes("gpt-5.3") ||
    normalized.includes("gpt-5.4") ||
    normalized.includes("opus-4-6");

  return {
    reasoning,
    supportsXhigh,
    knownModel: false,
  };
}

export function resolveActualThinkingLevel(requestedThinkingLevel: ThinkingLevel, capability: PiThinkingCapability): ThinkingLevel {
  if (!capability.reasoning) {
    return "off";
  }

  if (requestedThinkingLevel === "xhigh" && !capability.supportsXhigh) {
    return "high";
  }

  return requestedThinkingLevel;
}
