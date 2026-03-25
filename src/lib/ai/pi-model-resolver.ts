import { getModel, getProviders, supportsXhigh, type Api, type Model } from "@mariozechner/pi-ai";
import { createProviderCompatibility } from "./provider-compat";
import {
  getPiConfiguredApiLabel,
  getPiProviderForModelValue,
  getPiProviderOption,
  getPiThinkingCapability,
  resolveActualThinkingLevel,
} from "./pi-model-catalog";
import type { ApiFormat, ChatSettings, ModelConfigExecutionOverrides, ProviderCompatibility, ThinkingLevel } from "@/lib/chat/types";

const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const PI_BUILT_IN_PROVIDERS: Set<string> = new Set(getProviders());

export interface ResolvedPiModel {
  model: Model<Api>;
  apiKey?: string;
  actualApiFormat: ApiFormat;
  compatibility: ProviderCompatibility;
  actualThinkingLevel: ThinkingLevel;
  resolvedModelRef: string;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function parseProviderQualifiedModel(value: string): { provider: string; modelId: string } | null {
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex === value.length - 1) {
    return null;
  }

  return {
    provider: value.slice(0, slashIndex),
    modelId: value.slice(slashIndex + 1),
  };
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function looksLikeBuiltInPiModelReference(value: string): { provider: string; modelId: string } | null {
  const parsed = parseProviderQualifiedModel(value);
  if (!parsed || !PI_BUILT_IN_PROVIDERS.has(parsed.provider)) {
    return null;
  }

  return parsed;
}

export function resolveActualApiFormat(model: Model<Api>): ApiFormat {
  switch (model.api) {
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return "responses";
    default:
      return "chat_completions";
  }
}

function buildThinkingNotes(args: {
  requestedThinkingLevel: ThinkingLevel;
  actualThinkingLevel: ThinkingLevel;
  resolvedModelRef: string;
  reasoningCapable: boolean;
}): string[] {
  if (!args.reasoningCapable) {
    return [
      `Thinking requested: ${args.requestedThinkingLevel}. ${args.resolvedModelRef} does not expose reasoning here, so the run used off.`,
    ];
  }

  if (args.requestedThinkingLevel !== args.actualThinkingLevel) {
    return [
      `Thinking requested: ${args.requestedThinkingLevel}. The run used ${args.actualThinkingLevel} for model compatibility.`,
    ];
  }

  return [`Thinking level: ${args.actualThinkingLevel}.`];
}

export function createPiCompatibilityFromModel(
  model: Model<Api>,
  requestedApiFormat: ApiFormat | undefined,
  requestedThinkingLevel: ThinkingLevel,
  actualThinkingLevel: ThinkingLevel,
  resolvedModelRef: string,
): ProviderCompatibility {
  const actualApiFormat = resolveActualApiFormat(model);
  const requestedFormatIgnored = requestedApiFormat && requestedApiFormat !== actualApiFormat;
  const providerId = getPiProviderForModelValue(resolvedModelRef);
  const providerLabel =
    providerId === "openai-compatible"
      ? `Pi · ${titleCase(model.provider)}`
      : `Pi · ${getPiProviderOption(providerId).label}`;

  return {
    providerKey: model.provider === "openai" ? "openai" : "generic",
    providerLabel,
    baseUrl: model.baseUrl,
    chatCompletionsToolStyle: "tools",
    responsesContinuation: "replay",
    responsesPayloadMode: actualApiFormat === "responses" ? "sse" : "auto",
    notes: [
      `Resolved model: ${resolvedModelRef}`,
      `Model API: ${model.api}`,
      `Provider path: ${providerLabel} via ${model.api}`,
      "Executed through pi-agent-core + pi-ai.",
      ...buildThinkingNotes({
        requestedThinkingLevel,
        actualThinkingLevel,
        resolvedModelRef,
        reasoningCapable: model.reasoning,
      }),
      ...(requestedFormatIgnored
        ? [`Requested apiFormat ${requestedApiFormat} was mapped to ${actualApiFormat} for this model.`]
        : []),
    ],
  };
}

function createOpenAiCompatibleModel(
  settings: ChatSettings,
  requestedModel: string,
  baseUrl: string,
  overrides?: ModelConfigExecutionOverrides,
): ResolvedPiModel {
  const apiKey = overrides?.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Copy .env.example to .env.local and fill it in.");
  }

  const capability = getPiThinkingCapability(requestedModel);
  const actualThinkingLevel = resolveActualThinkingLevel(settings.thinkingLevel, capability);
  const actualApiFormat = settings.apiFormat;
  const compatibility = createProviderCompatibility(baseUrl, settings.providerMode);
  const resolvedModelRef = requestedModel;
  compatibility.notes = [
    ...compatibility.notes,
    "Executed through pi-agent-core + pi-ai.",
    `Resolved model: ${resolvedModelRef}`,
    `Provider path: ${getPiConfiguredApiLabel(requestedModel, settings.apiFormat)}`,
    ...buildThinkingNotes({
      requestedThinkingLevel: settings.thinkingLevel,
      actualThinkingLevel,
      resolvedModelRef: requestedModel || "OPENAI_MODEL",
      reasoningCapable: capability.reasoning,
    }),
  ];

  const model: Model<"openai-completions" | "openai-responses"> = {
    id: requestedModel,
    name: requestedModel,
    api: actualApiFormat === "responses" ? "openai-responses" : "openai-completions",
    provider: compatibility.providerKey === "openai" ? "openai" : "oceanking-openai-compatible",
    baseUrl,
    reasoning: capability.reasoning,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 200_000,
    maxTokens: 32_768,
  };

  return {
    model,
    apiKey,
    actualApiFormat,
    compatibility,
    actualThinkingLevel,
    resolvedModelRef,
  };
}

export function resolvePiModel(settings: ChatSettings, overrides?: ModelConfigExecutionOverrides): ResolvedPiModel {
  const requestedModel = settings.model.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  const builtInReference = looksLikeBuiltInPiModelReference(requestedModel);

  if (builtInReference) {
    const builtInModel = getModel(builtInReference.provider as never, builtInReference.modelId as never);
    if (!builtInModel) {
      throw new Error(`Unknown pi model reference "${requestedModel}".`);
    }

    const resolvedModelRef = `${builtInModel.provider}/${builtInModel.id}`;
    const actualThinkingLevel = resolveActualThinkingLevel(settings.thinkingLevel, {
      reasoning: builtInModel.reasoning,
      supportsXhigh: supportsXhigh(builtInModel),
      knownModel: true,
    });

    return {
      model: builtInModel,
      actualApiFormat: resolveActualApiFormat(builtInModel),
      compatibility: createPiCompatibilityFromModel(
        builtInModel,
        settings.apiFormat,
        settings.thinkingLevel,
        actualThinkingLevel,
        resolvedModelRef,
      ),
      actualThinkingLevel,
      resolvedModelRef,
    };
  }

  return createOpenAiCompatibleModel(
    settings,
    requestedModel,
    normalizeBaseUrl(overrides?.baseUrl?.trim() || process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL),
    overrides,
  );
}
