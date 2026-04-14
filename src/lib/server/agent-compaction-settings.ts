import {
  DEFAULT_COMPACTION_FRESH_TAIL_COUNT,
  DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  DEFAULT_MAX_TOOL_LOOP_STEPS,
  coerceCompactionFreshTailCount,
  coerceCompactionTokenThreshold,
  type ChatSettings,
  type ModelConfigExecutionOverrides,
  type RoomAgentId,
} from "@/lib/chat/types";
import { loadWorkspaceEnvelope } from "@/lib/server/workspace-store";
import { resolveSettingsWithModelConfig } from "@/lib/server/model-config-store";

export interface CompactionModelSelection {
  settings: ChatSettings;
  modelConfigOverrides?: ModelConfigExecutionOverrides;
  resolvedModel: string;
}

export interface AgentCompactionSettingsSelection {
  thresholdTokens: number;
  freshTailCount: number;
  modelSelection: CompactionModelSelection;
}

function createFallbackCompactionSettings(model: string): ChatSettings {
  return {
    modelConfigId: null,
    apiFormat: "chat_completions",
    model,
    systemPrompt: "",
    providerMode: "auto",
    memoryBackend: "sqlite-fts",
    compactionTokenThreshold: DEFAULT_COMPACTION_TOKEN_THRESHOLD,
    compactionFreshTailCount: DEFAULT_COMPACTION_FRESH_TAIL_COUNT,
    maxToolLoopSteps: DEFAULT_MAX_TOOL_LOOP_STEPS,
    thinkingLevel: "low",
    enabledSkillIds: [],
  };
}

function toCompactionPromptSettings(settings: ChatSettings, fallbackResolvedModel?: string): ChatSettings {
  const fallbackModel = fallbackResolvedModel?.trim() || settings.model.trim();
  return {
    ...createFallbackCompactionSettings(fallbackModel),
    modelConfigId: settings.modelConfigId,
    apiFormat: settings.apiFormat,
    model: settings.model.trim() || fallbackModel,
    providerMode: settings.providerMode,
    compactionTokenThreshold: coerceCompactionTokenThreshold(
      settings.compactionTokenThreshold ?? DEFAULT_COMPACTION_TOKEN_THRESHOLD,
    ),
    compactionFreshTailCount: coerceCompactionFreshTailCount(
      settings.compactionFreshTailCount ?? DEFAULT_COMPACTION_FRESH_TAIL_COUNT,
    ),
  };
}

function createFallbackModelSelection(currentSettings: ChatSettings | undefined, fallbackResolvedModel?: string): CompactionModelSelection {
  const fallbackSettings = toCompactionPromptSettings(
    currentSettings ?? createFallbackCompactionSettings(fallbackResolvedModel?.trim() || ""),
    fallbackResolvedModel,
  );
  return {
    settings: fallbackSettings,
    resolvedModel: fallbackResolvedModel?.trim() || fallbackSettings.model.trim(),
  };
}

export async function resolveAgentCompactionSettingsSelection(
  agentId: RoomAgentId,
  fallbackResolvedModel?: string,
): Promise<AgentCompactionSettingsSelection> {
  const workspace = await loadWorkspaceEnvelope().catch(() => null);
  const currentSettings = workspace?.state.agentStates[agentId]?.settings;

  const baseSelection = createFallbackModelSelection(currentSettings, fallbackResolvedModel);

  let modelSelection = baseSelection;
  if (currentSettings) {
    try {
      const resolvedSelection = await resolveSettingsWithModelConfig(currentSettings);
      modelSelection = {
        settings: toCompactionPromptSettings(resolvedSelection.settings, fallbackResolvedModel),
        resolvedModel: fallbackResolvedModel?.trim() || resolvedSelection.settings.model.trim(),
        ...(resolvedSelection.modelConfigOverrides
          ? { modelConfigOverrides: resolvedSelection.modelConfigOverrides }
          : {}),
      };
    } catch {
      modelSelection = baseSelection;
    }
  }

  return {
    thresholdTokens: coerceCompactionTokenThreshold(
      currentSettings?.compactionTokenThreshold ?? DEFAULT_COMPACTION_TOKEN_THRESHOLD,
    ),
    freshTailCount: coerceCompactionFreshTailCount(
      currentSettings?.compactionFreshTailCount ?? DEFAULT_COMPACTION_FRESH_TAIL_COUNT,
    ),
    modelSelection,
  };
}
