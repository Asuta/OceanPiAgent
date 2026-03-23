import type {
  ChatCompletionsToolStyle,
  ProviderCompatibility,
  ProviderKey,
  ProviderMode,
  ResponsesContinuation,
} from "@/lib/chat/types";

type ProviderPreset = Omit<ProviderCompatibility, "baseUrl">;

const PROVIDER_PRESETS: Record<ProviderKey, ProviderPreset> = {
  openai: {
    providerKey: "openai",
    providerLabel: "OpenAI",
    chatCompletionsToolStyle: "tools",
    responsesContinuation: "previous_response_id",
    responsesPayloadMode: "json",
    notes: [
      "Prefer modern tools for Chat Completions.",
      "Try previous_response_id first for Responses follow-ups.",
    ],
  },
  right_codes: {
    providerKey: "right_codes",
    providerLabel: "right.codes",
    chatCompletionsToolStyle: "tools",
    responsesContinuation: "replay",
    responsesPayloadMode: "sse",
    notes: [
      "Responses payloads may arrive as SSE even without streaming.",
      "Responses follow-ups replay prior function_call items instead of previous_response_id.",
    ],
  },
  generic: {
    providerKey: "generic",
    providerLabel: "OpenAI-Compatible",
    chatCompletionsToolStyle: "tools",
    responsesContinuation: "replay",
    responsesPayloadMode: "auto",
    notes: [
      "Auto-parse JSON or SSE payloads.",
      "Use replay mode for Responses when provider quirks are unknown.",
      "Fall back to legacy functions for older Chat Completions providers.",
    ],
  },
};

function detectProviderKey(baseUrl: string): ProviderKey {
  const normalizedBaseUrl = baseUrl.toLowerCase();

  if (normalizedBaseUrl.includes("api.openai.com")) {
    return "openai";
  }

  if (normalizedBaseUrl.includes("right.codes")) {
    return "right_codes";
  }

  return "generic";
}

function resolveProviderKey(baseUrl: string, providerMode?: ProviderMode): ProviderKey {
  if (providerMode && providerMode !== "auto") {
    return providerMode;
  }

  const envMode = process.env.OPENAI_PROVIDER_MODE?.trim().toLowerCase();
  if (envMode === "openai" || envMode === "right_codes" || envMode === "generic") {
    return envMode;
  }

  return detectProviderKey(baseUrl);
}

export function createProviderCompatibility(
  baseUrl: string,
  providerMode?: ProviderMode,
): ProviderCompatibility {
  const providerKey = resolveProviderKey(baseUrl, providerMode);
  const preset = PROVIDER_PRESETS[providerKey];

  return {
    ...preset,
    baseUrl,
  };
}

export function getChatCompletionsStyleOrder(
  compatibility: ProviderCompatibility,
): ChatCompletionsToolStyle[] {
  const fallbackStyle: ChatCompletionsToolStyle =
    compatibility.chatCompletionsToolStyle === "tools" ? "functions" : "tools";

  return [compatibility.chatCompletionsToolStyle, fallbackStyle];
}

export function getResponsesContinuationOrder(
  compatibility: ProviderCompatibility,
): ResponsesContinuation[] {
  const fallbackStrategy: ResponsesContinuation =
    compatibility.responsesContinuation === "previous_response_id" ? "replay" : "previous_response_id";

  return [compatibility.responsesContinuation, fallbackStrategy];
}

export function shouldFallbackToLegacyFunctions(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("unsupported parameter") ||
    message.includes("unknown parameter") ||
    message.includes("tool_choice") ||
    message.includes("tools")
  );
}

export function shouldFallbackToResponsesReplay(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("previous_response_id") ||
    message.includes("no tool call found") ||
    message.includes("unsupported parameter")
  );
}
