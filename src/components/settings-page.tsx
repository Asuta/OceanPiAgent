"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import {
  applyModelConfigToSettings,
  buildLegacyModelConfigSeed,
  createEmptyModelConfigDraft,
  getModelConfigApiLabel,
  getModelConfigKindLabel,
} from "@/lib/ai/model-configs";
import {
  getPiConfiguredApiLabel,
  getPiDefaultModelValue,
  getPiModelOptionByValue,
  getPiModelOptions,
  getPiProviderForModelValue,
  getPiProviderOption,
  getPiProviderOptions,
  getPiThinkingCapability,
  resolveActualThinkingLevel,
  type PiProviderId,
} from "@/lib/ai/pi-model-catalog";
import {
  MAX_MAX_TOOL_LOOP_STEPS,
  MIN_MAX_TOOL_LOOP_STEPS,
  type ApiFormat,
  type ModelConfig,
  type ModelConfigKind,
  type ProviderMode,
  type RoomAgentDefinition,
  type ThinkingLevel,
} from "@/lib/chat/types";
import {
  formatTimestamp,
  getCompatibilityDetailPills,
  getCompatibilityModeLabel,
  useWorkspace,
} from "@/components/workspace-provider";
import { RESOLVED_THEME_LABELS, THEME_OPTION_LABELS, THEME_PREFERENCES } from "@/lib/theme";

const PROVIDER_MODE_OPTIONS: Array<{ value: ProviderMode; label: string }> = [
  { value: "auto", label: "自动" },
  { value: "openai", label: "OpenAI" },
  { value: "right_codes", label: "right.codes" },
  { value: "generic", label: "通用兼容" },
];

const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "默认",
  none: "none",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
};

const THINKING_LEVEL_OPTIONS: Array<{ value: ThinkingLevel; label: string }> = [
  { value: "off", label: "默认" },
  { value: "none", label: "none" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

const CUSTOM_MODEL_OPTION = "__custom_model__";
const NEW_MODEL_CONFIG_ID = "__new_model_config__";
const DEFAULT_PI_NATIVE_PROVIDER_ID: PiProviderId = "openai";
const PI_NATIVE_PROVIDER_OPTIONS = getPiProviderOptions().filter((option) => !option.usesCustomEndpoint);

interface WorkspaceSkillSummary {
  id: string;
  title: string;
  summary: string;
}

interface FeishuRuntimeLogEntry {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

interface FeishuRuntimeStatus {
  enabled: boolean;
  configured: boolean;
  status: "disabled" | "idle" | "starting" | "running" | "error";
  accountId: string;
  defaultAgentId: string;
  allowOpenIds: string[];
  ackReactionEmojiType: string;
  doneReactionEmojiType: string;
  lastError: string | null;
  startedAt: string | null;
  lastInboundAt: string | null;
  logFilePath: string;
  recentLogs: FeishuRuntimeLogEntry[];
}

interface FeishuBackfillResult {
  scanned: number;
  updated: number;
  skipped: number;
}

interface ModelConfigDraft {
  name: string;
  kind: ModelConfigKind;
  model: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  providerMode: ProviderMode;
  apiKey: string;
  clearApiKey: boolean;
  builtInProviderId: PiProviderId;
}

interface AgentEditorDraft {
  label: string;
  summary: string;
  workingStyle: string;
  skillsText: string;
  instruction: string;
}

function createAgentEditorDraft(agent: RoomAgentDefinition): AgentEditorDraft {
  return {
    label: agent.label,
    summary: agent.summary,
    workingStyle: agent.workingStyle,
    skillsText: agent.skills.join(", "),
    instruction: agent.instruction,
  };
}

function parseSkillsText(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function getThinkingNote(args: {
  modelRef: string;
  requestedThinkingLevel: ThinkingLevel;
  actualThinkingLevel: ThinkingLevel;
}) {
  const capability = getPiThinkingCapability(args.modelRef);
  if (!args.modelRef.trim()) {
    return "Model config can leave the model empty and follow the environment default. Thinking only applies when the final model supports reasoning.";
  }

  if (!capability.reasoning) {
    return "The current model does not expose reasoning, so requests run with Thinking Off.";
  }

  if (args.requestedThinkingLevel !== args.actualThinkingLevel) {
    return `The current model clamps ${THINKING_LEVEL_LABELS[args.requestedThinkingLevel]} down to ${THINKING_LEVEL_LABELS[args.actualThinkingLevel]}.`;
  }

  return `The current model supports reasoning and runs with ${THINKING_LEVEL_LABELS[args.actualThinkingLevel]}.`;
}

function getBuiltInProviderId(modelValue: string, fallback = DEFAULT_PI_NATIVE_PROVIDER_ID): PiProviderId {
  const providerId = getPiProviderForModelValue(modelValue);
  return providerId === "openai-compatible" ? fallback : providerId;
}

function sortModelConfigs(modelConfigs: ModelConfig[]): ModelConfig[] {
  return [...modelConfigs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name));
}

function getModelConfigSignature(modelConfig: Pick<ModelConfig, "kind" | "model" | "apiFormat" | "providerMode" | "baseUrl">): string {
  return [modelConfig.kind, modelConfig.model.trim(), modelConfig.apiFormat, modelConfig.providerMode, modelConfig.baseUrl.trim()].join("::");
}

function createDraftFromModelConfig(modelConfig: ModelConfig): ModelConfigDraft {
  return {
    name: modelConfig.name,
    kind: modelConfig.kind,
    model: modelConfig.model,
    apiFormat: modelConfig.apiFormat,
    baseUrl: modelConfig.baseUrl,
    providerMode: modelConfig.providerMode,
    apiKey: "",
    clearApiKey: false,
    builtInProviderId: getBuiltInProviderId(modelConfig.model),
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

async function fetchModelConfigs(): Promise<ModelConfig[]> {
  const response = await fetch("/api/model-configs", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to load model configs.");
  }

  const payload = await parseJsonResponse<{ modelConfigs?: ModelConfig[] }>(response);
  return sortModelConfigs(payload?.modelConfigs ?? []);
}

async function fetchFeishuRuntimeStatus(): Promise<FeishuRuntimeStatus> {
  const response = await fetch("/api/channels/feishu/status", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to load Feishu runtime status.");
  }

  const payload = await parseJsonResponse<FeishuRuntimeStatus>(response);
  if (!payload) {
    throw new Error("Feishu runtime status returned an empty response.");
  }
  return payload;
}

async function fetchFeishuRuntimeLogs(limit = 50): Promise<{ logFilePath: string; logs: FeishuRuntimeLogEntry[] }> {
  const response = await fetch(`/api/channels/feishu/logs?limit=${limit}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to load Feishu runtime logs.");
  }

  const payload = await parseJsonResponse<{ logFilePath?: string; logs?: FeishuRuntimeLogEntry[] }>(response);
  return {
    logFilePath: payload?.logFilePath ?? "",
    logs: payload?.logs ?? [],
  };
}

async function runFeishuNicknameBackfill(): Promise<FeishuBackfillResult> {
  const response = await fetch("/api/channels/feishu/backfill", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });
  const payload = await parseJsonResponse<FeishuBackfillResult & { error?: string }>(response);
  if (!response.ok || !payload) {
    throw new Error(payload?.error || "Failed to backfill Feishu nicknames.");
  }
  return payload;
}

async function createModelConfigRequest(draft: ModelConfigDraft): Promise<ModelConfig> {
  const response = await fetch("/api/model-configs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: draft.name,
      kind: draft.kind,
      model: draft.model,
      apiFormat: draft.apiFormat,
      baseUrl: draft.baseUrl,
      providerMode: draft.providerMode,
      apiKey: draft.apiKey,
      clearApiKey: draft.clearApiKey,
    }),
  });
  const payload = await parseJsonResponse<{ modelConfig?: ModelConfig; error?: string }>(response);
  if (!response.ok || !payload?.modelConfig) {
    throw new Error(payload?.error || "Failed to create model config.");
  }

  return payload.modelConfig;
}

async function updateModelConfigRequest(configId: string, draft: ModelConfigDraft): Promise<ModelConfig> {
  const response = await fetch(`/api/model-configs/${configId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: draft.name,
      kind: draft.kind,
      model: draft.model,
      apiFormat: draft.apiFormat,
      baseUrl: draft.baseUrl,
      providerMode: draft.providerMode,
      apiKey: draft.apiKey,
      clearApiKey: draft.clearApiKey,
    }),
  });
  const payload = await parseJsonResponse<{ modelConfig?: ModelConfig; error?: string }>(response);
  if (!response.ok || !payload?.modelConfig) {
    throw new Error(payload?.error || "Failed to update model config.");
  }

  return payload.modelConfig;
}

async function deleteModelConfigRequest(configId: string): Promise<void> {
  const response = await fetch(`/api/model-configs/${configId}`, {
    method: "DELETE",
  });
  const payload = await parseJsonResponse<{ error?: string }>(response);
  if (!response.ok) {
    throw new Error(payload?.error || "Failed to delete model config.");
  }
}

export function SettingsPage() {
  const { mounted: themeMounted, resolvedTheme, setThemePreference, systemTheme, themePreference } = useTheme();
  const {
    agents,
    agentStates,
    agentCompactionFeedback,
    runningAgentRequestIds,
    isAgentRunning,
    isAgentCompacting,
    clearAgentConsole,
    compactAgentContext,
    createAgentDefinition,
    getRoomById,
    updateAgentSettings,
    updateAgentDefinition,
  } = useWorkspace();
  const [settingsTab, setSettingsTab] = useState<"models" | "agents" | "runtime">("models");
  const [availableSkills, setAvailableSkills] = useState<WorkspaceSkillSummary[]>([]);
  const [agentDraftsById, setAgentDraftsById] = useState<Record<string, AgentEditorDraft>>({});
  const [savingAgentIds, setSavingAgentIds] = useState<Record<string, boolean>>({});
  const [agentErrorById, setAgentErrorById] = useState<Record<string, string>>({});
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [createAgentError, setCreateAgentError] = useState("");
  const [newAgentId, setNewAgentId] = useState("");
  const [newAgentDraft, setNewAgentDraft] = useState<AgentEditorDraft>({
    label: "",
    summary: "",
    workingStyle: "",
    skillsText: "",
    instruction: "",
  });
  const [modelConfigs, setModelConfigs] = useState<ModelConfig[]>([]);
  const [selectedModelConfigId, setSelectedModelConfigId] = useState<string>(NEW_MODEL_CONFIG_ID);
  const [modelConfigDraft, setModelConfigDraft] = useState<ModelConfigDraft>(() => ({
    ...createEmptyModelConfigDraft(),
    builtInProviderId: DEFAULT_PI_NATIVE_PROVIDER_ID,
  }));
  const [modelConfigError, setModelConfigError] = useState("");
  const [loadingModelConfigs, setLoadingModelConfigs] = useState(true);
  const [savingModelConfig, setSavingModelConfig] = useState(false);
  const [feishuRuntimeStatus, setFeishuRuntimeStatus] = useState<FeishuRuntimeStatus | null>(null);
  const [feishuRuntimeLogs, setFeishuRuntimeLogs] = useState<FeishuRuntimeLogEntry[]>([]);
  const [feishuRuntimeLogPath, setFeishuRuntimeLogPath] = useState("");
  const [feishuRuntimeError, setFeishuRuntimeError] = useState("");
  const [loadingFeishuRuntime, setLoadingFeishuRuntime] = useState(false);
  const [runningFeishuBackfill, setRunningFeishuBackfill] = useState(false);
  const [feishuBackfillMessage, setFeishuBackfillMessage] = useState("");
  const legacyMigrationStartedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [skillsResponse, modelConfigResult] = await Promise.all([
        fetch("/api/skills").catch(() => null),
        fetchModelConfigs().catch((error) => {
          if (!cancelled) {
            setModelConfigError(error instanceof Error ? error.message : "Failed to load model configs.");
          }
          return null;
        }),
      ]);

      if (cancelled) {
        return;
      }

      if (skillsResponse?.ok) {
        const payload = (await skillsResponse.json().catch(() => null)) as { skills?: WorkspaceSkillSummary[] } | null;
        if (payload?.skills) {
          setAvailableSkills(payload.skills);
        }
      }

      if (modelConfigResult) {
        setModelConfigs(modelConfigResult);
      }

      setLoadingModelConfigs(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setAgentDraftsById((current) => {
      const next = { ...current };
      for (const agent of agents) {
        if (!next[agent.id]) {
          next[agent.id] = createAgentEditorDraft(agent);
        }
      }
      return next;
    });
  }, [agents]);

  useEffect(() => {
    if (selectedModelConfigId === NEW_MODEL_CONFIG_ID) {
      return;
    }

    const selectedModelConfig = modelConfigs.find((modelConfig) => modelConfig.id === selectedModelConfigId);
    if (!selectedModelConfig) {
      setSelectedModelConfigId(NEW_MODEL_CONFIG_ID);
      setModelConfigDraft({
        ...createEmptyModelConfigDraft(modelConfigs.length + 1),
        builtInProviderId: DEFAULT_PI_NATIVE_PROVIDER_ID,
      });
      return;
    }

    setModelConfigDraft(createDraftFromModelConfig(selectedModelConfig));
  }, [modelConfigs, selectedModelConfigId]);

  useEffect(() => {
    if (loadingModelConfigs || legacyMigrationStartedRef.current) {
      return;
    }

    legacyMigrationStartedRef.current = true;

    void (async () => {
      let nextModelConfigs = [...modelConfigs];
      const configBySignature = new Map(nextModelConfigs.map((modelConfig) => [getModelConfigSignature(modelConfig), modelConfig]));

      for (const agent of agents) {
        const state = agentStates[agent.id];
        if (state.settings.modelConfigId) {
          continue;
        }

        const seed = buildLegacyModelConfigSeed(state.settings, `${agent.label} Model`);
        if (!seed) {
          continue;
        }

        const signature = getModelConfigSignature({
          kind: seed.kind,
          model: seed.model,
          apiFormat: seed.apiFormat,
          providerMode: seed.providerMode,
          baseUrl: seed.baseUrl,
        });
        let modelConfig = configBySignature.get(signature) ?? null;
        if (!modelConfig) {
          try {
            modelConfig = await createModelConfigRequest({
              ...seed,
              apiKey: "",
              clearApiKey: false,
              builtInProviderId: getBuiltInProviderId(seed.model),
            });
          } catch {
            continue;
          }

          nextModelConfigs = sortModelConfigs([...nextModelConfigs, modelConfig]);
          configBySignature.set(signature, modelConfig);
          setModelConfigs(nextModelConfigs);
        }

        updateAgentSettings(agent.id, applyModelConfigToSettings(state.settings, modelConfig));
      }
    })();
  }, [agentStates, agents, loadingModelConfigs, modelConfigs, updateAgentSettings]);

  useEffect(() => {
    if (settingsTab !== "runtime") {
      return;
    }

    let cancelled = false;

    const loadRuntime = async (showLoading: boolean) => {
      if (showLoading) {
        setLoadingFeishuRuntime(true);
      }

      try {
        const [status, logsPayload] = await Promise.all([fetchFeishuRuntimeStatus(), fetchFeishuRuntimeLogs(60)]);
        if (cancelled) {
          return;
        }
        setFeishuRuntimeStatus(status);
        setFeishuRuntimeLogs(logsPayload.logs);
        setFeishuRuntimeLogPath(logsPayload.logFilePath || status.logFilePath);
        setFeishuRuntimeError("");
      } catch (error) {
        if (cancelled) {
          return;
        }
        setFeishuRuntimeError(error instanceof Error ? error.message : "Failed to load Feishu runtime info.");
      } finally {
        if (!cancelled) {
          setLoadingFeishuRuntime(false);
        }
      }
    };

    void loadRuntime(true);
    const intervalId = window.setInterval(() => {
      void loadRuntime(false);
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [settingsTab]);

  const syncAgentsWithModelConfig = (modelConfig: ModelConfig) => {
    for (const agent of agents) {
      const state = agentStates[agent.id];
      if (state.settings.modelConfigId === modelConfig.id) {
        updateAgentSettings(agent.id, applyModelConfigToSettings(state.settings, modelConfig));
      }
    }
  };

  const handleCreateNewModelConfig = () => {
    setSelectedModelConfigId(NEW_MODEL_CONFIG_ID);
    setModelConfigDraft({
      ...createEmptyModelConfigDraft(modelConfigs.length + 1),
      builtInProviderId: DEFAULT_PI_NATIVE_PROVIDER_ID,
    });
    setModelConfigError("");
  };

  const handleSaveModelConfig = async () => {
    if (!modelConfigDraft.name.trim()) {
      setModelConfigError("Please give the model config a name.");
      return;
    }

    if (modelConfigDraft.kind === "pi_builtin" && !modelConfigDraft.model.trim()) {
      setModelConfigError("Pi native model configs need a model reference.");
      return;
    }

    setSavingModelConfig(true);
    setModelConfigError("");

    try {
      const savedModelConfig =
        selectedModelConfigId === NEW_MODEL_CONFIG_ID
          ? await createModelConfigRequest(modelConfigDraft)
          : await updateModelConfigRequest(selectedModelConfigId, modelConfigDraft);

      setModelConfigs((current) => {
        const next = current.filter((modelConfig) => modelConfig.id !== savedModelConfig.id);
        return sortModelConfigs([...next, savedModelConfig]);
      });
      setSelectedModelConfigId(savedModelConfig.id);
      setModelConfigDraft(createDraftFromModelConfig(savedModelConfig));
      syncAgentsWithModelConfig(savedModelConfig);
    } catch (error) {
      setModelConfigError(error instanceof Error ? error.message : "Failed to save model config.");
    } finally {
      setSavingModelConfig(false);
    }
  };

  const handleDeleteModelConfig = async () => {
    if (selectedModelConfigId === NEW_MODEL_CONFIG_ID) {
      return;
    }

    setSavingModelConfig(true);
    setModelConfigError("");

    try {
      await deleteModelConfigRequest(selectedModelConfigId);
      for (const agent of agents) {
        const state = agentStates[agent.id];
        if (state.settings.modelConfigId === selectedModelConfigId) {
          updateAgentSettings(agent.id, { modelConfigId: null });
        }
      }
      setModelConfigs((current) => current.filter((modelConfig) => modelConfig.id !== selectedModelConfigId));
      handleCreateNewModelConfig();
    } catch (error) {
      setModelConfigError(error instanceof Error ? error.message : "Failed to delete model config.");
    } finally {
      setSavingModelConfig(false);
    }
  };

  const selectedModelConfig = modelConfigs.find((modelConfig) => modelConfig.id === selectedModelConfigId) ?? null;

  const updateAgentDraft = (agentId: string, patch: Partial<AgentEditorDraft>) => {
    setAgentDraftsById((current) => ({
      ...current,
      [agentId]: {
        ...(current[agentId]
          ?? createAgentEditorDraft(
            agents.find((agent) => agent.id === agentId) ?? {
              id: agentId,
              label: agentId,
              summary: "",
              skills: [],
              workingStyle: "",
              instruction: "",
            },
          )),
        ...patch,
      },
    }));
  };

  const handleSaveAgent = async (agentId: string) => {
    const draft = agentDraftsById[agentId];
    if (!draft || !draft.label.trim() || !draft.summary.trim() || !draft.workingStyle.trim()) {
      setAgentErrorById((current) => ({
        ...current,
        [agentId]: "请先填写 label、summary 和 working style。",
      }));
      return;
    }

    setSavingAgentIds((current) => ({ ...current, [agentId]: true }));
    setAgentErrorById((current) => ({ ...current, [agentId]: "" }));
    try {
      const savedAgent = await updateAgentDefinition(agentId, {
        label: draft.label,
        summary: draft.summary,
        workingStyle: draft.workingStyle,
        skills: parseSkillsText(draft.skillsText),
        instruction: draft.instruction,
      });
      setAgentDraftsById((current) => ({
        ...current,
        [agentId]: createAgentEditorDraft(savedAgent),
      }));
    } catch (error) {
      setAgentErrorById((current) => ({
        ...current,
        [agentId]: error instanceof Error ? error.message : "保存 Agent 失败。",
      }));
    } finally {
      setSavingAgentIds((current) => {
        const next = { ...current };
        delete next[agentId];
        return next;
      });
    }
  };

  const handleCreateAgent = async () => {
    if (!newAgentId.trim() || !newAgentDraft.label.trim() || !newAgentDraft.summary.trim() || !newAgentDraft.workingStyle.trim()) {
      setCreateAgentError("请先填写 Agent ID、Label、Summary 和 Working Style。");
      return;
    }

    setCreatingAgent(true);
    setCreateAgentError("");
    try {
      const createdAgent = await createAgentDefinition({
        id: newAgentId,
        label: newAgentDraft.label,
        summary: newAgentDraft.summary,
        workingStyle: newAgentDraft.workingStyle,
        skills: parseSkillsText(newAgentDraft.skillsText),
        instruction: newAgentDraft.instruction,
      });
      setNewAgentId("");
      setNewAgentDraft({
        label: "",
        summary: "",
        workingStyle: "",
        skillsText: "",
        instruction: "",
      });
      setAgentDraftsById((current) => ({
        ...current,
        [createdAgent.id]: createAgentEditorDraft(createdAgent),
      }));
    } catch (error) {
      setCreateAgentError(error instanceof Error ? error.message : "创建 Agent 失败。");
    } finally {
      setCreatingAgent(false);
    }
  };

  const handleRefreshFeishuRuntime = async () => {
    setLoadingFeishuRuntime(true);
    try {
      const [status, logsPayload] = await Promise.all([fetchFeishuRuntimeStatus(), fetchFeishuRuntimeLogs(60)]);
      setFeishuRuntimeStatus(status);
      setFeishuRuntimeLogs(logsPayload.logs);
      setFeishuRuntimeLogPath(logsPayload.logFilePath || status.logFilePath);
      setFeishuRuntimeError("");
    } catch (error) {
      setFeishuRuntimeError(error instanceof Error ? error.message : "Failed to refresh Feishu runtime info.");
    } finally {
      setLoadingFeishuRuntime(false);
    }
  };

  const handleBackfillFeishuNicknames = async () => {
    setRunningFeishuBackfill(true);
    setFeishuBackfillMessage("");
    try {
      const result = await runFeishuNicknameBackfill();
      setFeishuBackfillMessage(`已扫描 ${result.scanned} 个房间，更新 ${result.updated} 个，跳过 ${result.skipped} 个。`);
      await handleRefreshFeishuRuntime();
    } catch (error) {
      setFeishuBackfillMessage(error instanceof Error ? error.message : "Feishu nickname backfill failed.");
    } finally {
      setRunningFeishuBackfill(false);
    }
  };

  const renderAgentCard = (agent: RoomAgentDefinition, view: "agents" | "runtime") => {
    const state = agentStates[agent.id];
    const agentDraft = agentDraftsById[agent.id] ?? createAgentEditorDraft(agent);
    const compactionFeedback = agentCompactionFeedback[agent.id];
    const agentError = agentErrorById[agent.id] ?? "";
    const isSavingAgent = Boolean(savingAgentIds[agent.id]);
    const isRunning = isAgentRunning(agent.id);
    const isCompacting = isAgentCompacting(agent.id);
    const runningRoomId = runningAgentRequestIds[agent.id] ?? null;
    const runningRoom = runningRoomId ? getRoomById(runningRoomId) : null;
    const compatibilityPills = getCompatibilityDetailPills(state.compatibility);
    const selectedConfig = modelConfigs.find((modelConfig) => modelConfig.id === state.settings.modelConfigId) ?? null;
    const effectiveModelRef = selectedConfig?.model ?? state.settings.model;
    const effectiveApiFormat = selectedConfig?.apiFormat ?? state.settings.apiFormat;
    const effectiveProviderId = getPiProviderForModelValue(effectiveModelRef);
    const effectiveProviderOption = getPiProviderOption(effectiveProviderId);
    const selectedModelOption = getPiModelOptionByValue(effectiveModelRef);
    const capability = getPiThinkingCapability(effectiveModelRef);
    const actualThinkingLevel = resolveActualThinkingLevel(state.settings.thinkingLevel, capability);
    const configuredApiLabel = selectedConfig ? getModelConfigApiLabel(selectedConfig) : getPiConfiguredApiLabel(effectiveModelRef, effectiveApiFormat);

    if (view === "agents") {
      return (
        <article key={agent.id} className="surface-panel settings-card">
          <div className="settings-card-header">
            <div>
              <p className="section-label">Agent Preset</p>
              <h2>{agent.label}</h2>
              <p>{agent.summary}</p>
            </div>
            <div className="meta-chip-row compact align-end">
              <span className="meta-chip">{selectedConfig?.name || "未选择模型配置"}</span>
              <span className="meta-chip subtle">{configuredApiLabel}</span>
              <span className="meta-chip subtle">{isRunning ? "运行中" : "空闲"}</span>
            </div>
          </div>

          <div className="form-grid two-columns top-gap">
            <label className="field-block" htmlFor={`${agent.id}-label`}>
              <span>Label</span>
              <input
                id={`${agent.id}-label`}
                className="text-input"
                value={agentDraft.label}
                onChange={(event) => updateAgentDraft(agent.id, { label: event.target.value })}
                disabled={isSavingAgent}
              />
            </label>

            <label className="field-block" htmlFor={`${agent.id}-skills`}>
              <span>Skills</span>
              <input
                id={`${agent.id}-skills`}
                className="text-input"
                value={agentDraft.skillsText}
                onChange={(event) => updateAgentDraft(agent.id, { skillsText: event.target.value })}
                disabled={isSavingAgent}
              />
            </label>

            <label className="field-block" htmlFor={`${agent.id}-summary`}>
              <span>Summary</span>
              <textarea
                id={`${agent.id}-summary`}
                className="text-area compact"
                value={agentDraft.summary}
                onChange={(event) => updateAgentDraft(agent.id, { summary: event.target.value })}
                disabled={isSavingAgent}
              />
            </label>

            <label className="field-block" htmlFor={`${agent.id}-style`}>
              <span>Working Style</span>
              <textarea
                id={`${agent.id}-style`}
                className="text-area compact"
                value={agentDraft.workingStyle}
                onChange={(event) => updateAgentDraft(agent.id, { workingStyle: event.target.value })}
                disabled={isSavingAgent}
              />
            </label>
          </div>

          <label className="field-block top-gap" htmlFor={`${agent.id}-private-prompt`}>
            <span>Private Prompt</span>
            <textarea
              id={`${agent.id}-private-prompt`}
              className="text-area compact"
              value={agentDraft.instruction}
              onChange={(event) => updateAgentDraft(agent.id, { instruction: event.target.value })}
              placeholder="写入这个 Agent workspace 的私有提示词。"
              disabled={isSavingAgent}
            />
          </label>

          {isRunning ? (
            <p className="muted-copy top-gap">
              {runningRoom
                ? `当前 Agent 正在房间“${runningRoom.title}”中运行。你现在的修改会从下一轮开始生效，不影响这轮已启动的执行。`
                : "当前 Agent 正在运行。你现在的修改会从下一轮开始生效，不影响这轮已启动的执行。"}
            </p>
          ) : null}

          {agentError ? <p className="muted-copy top-gap danger-text">{agentError}</p> : null}

          <div className="card-actions compact-right top-gap">
            <button type="button" className="ghost-button" onClick={() => void handleSaveAgent(agent.id)} disabled={isSavingAgent}>
              {isSavingAgent ? "保存中..." : "保存 Agent 资料"}
            </button>
          </div>

          <div className="form-grid two-columns">
            <label className="field-block" htmlFor={`${agent.id}-model-config`}>
              <span>模型配置</span>
              <select
                id={`${agent.id}-model-config`}
                className="text-input"
                value={state.settings.modelConfigId ?? ""}
                onChange={(event) => {
                  const nextModelConfigId = event.target.value || null;
                  if (!nextModelConfigId) {
                    updateAgentSettings(agent.id, { modelConfigId: null });
                    return;
                  }

                  const nextModelConfig = modelConfigs.find((modelConfig) => modelConfig.id === nextModelConfigId);
                  if (!nextModelConfig) {
                    return;
                  }

                  updateAgentSettings(agent.id, applyModelConfigToSettings(state.settings, nextModelConfig));
                }}
              >
                <option value="">未选择</option>
                {modelConfigs.map((modelConfig) => (
                  <option key={modelConfig.id} value={modelConfig.id}>
                    {modelConfig.name}
                  </option>
                ))}
              </select>
              <p className="muted-copy">选择上方已经保存好的模型配置。没有的话先在“模型配置”里创建。</p>
            </label>

            <div className="field-block static-field">
              <span>当前模型目标</span>
              <div className="info-badge">{effectiveModelRef || "未配置"}</div>
            </div>

            <label className="field-block" htmlFor={`${agent.id}-thinking`}>
              <span>Thinking Level</span>
              <select
                id={`${agent.id}-thinking`}
                className="text-input"
                value={state.settings.thinkingLevel}
                onChange={(event) => updateAgentSettings(agent.id, { thinkingLevel: event.target.value as ThinkingLevel })}
              >
                {THINKING_LEVEL_OPTIONS.map((option, index) => (
                  <option key={`${option.value}-${index}`} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="muted-copy">
                {getThinkingNote({
                  modelRef: effectiveModelRef,
                  requestedThinkingLevel: state.settings.thinkingLevel,
                  actualThinkingLevel,
                })}
              </p>
            </label>

            <label className="field-block" htmlFor={`${agent.id}-steps`}>
              <span>最大 Tool Loop</span>
              <input
                id={`${agent.id}-steps`}
                type="number"
                min={MIN_MAX_TOOL_LOOP_STEPS}
                max={MAX_MAX_TOOL_LOOP_STEPS}
                step={1}
                className="text-input"
                value={state.settings.maxToolLoopSteps}
                onChange={(event) => updateAgentSettings(agent.id, { maxToolLoopSteps: event.target.valueAsNumber })}
              />
            </label>
          </div>

          <label className="field-block" htmlFor={`${agent.id}-prompt`}>
            <span>Operator Override</span>
            <textarea
              id={`${agent.id}-prompt`}
              className="text-area compact"
              value={state.settings.systemPrompt}
              onChange={(event) => updateAgentSettings(agent.id, { systemPrompt: event.target.value })}
              placeholder="追加到基础 system prompt 的临时 operator note。"
            />
          </label>

          <section className="subtle-panel top-gap">
            <p className="section-label">Workspace Skills</p>
            {availableSkills.length > 0 ? (
              <>
                <div className="meta-chip-row compact top-gap">
                  {availableSkills.map((skill) => {
                    const active = state.settings.enabledSkillIds.includes(skill.id);
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        className={active ? "tab-button active" : "tab-button"}
                        onClick={() =>
                          updateAgentSettings(agent.id, {
                            enabledSkillIds: active
                              ? state.settings.enabledSkillIds.filter((skillId) => skillId !== skill.id)
                              : [...state.settings.enabledSkillIds, skill.id],
                          })
                        }
                      >
                        {skill.title}
                      </button>
                    );
                  })}
                </div>
                <ul className="notes-list top-gap">
                  {availableSkills.map((skill) => (
                    <li key={skill.id}>
                      <strong>{skill.title}:</strong> {skill.summary}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="muted-copy top-gap">当前没有发现 `skills/*/SKILL.md`。你可以在项目根目录里新增技能文件夹；启用后它们会进入技能目录，模型命中时再按需读取。</p>
            )}
          </section>
        </article>
      );
    }

    return (
      <article key={agent.id} className="surface-panel settings-card">
        <div className="settings-card-header">
          <div>
            <p className="section-label">Runtime</p>
            <h2>{agent.label}</h2>
            <p>把模型路由、兼容策略和上下文维护集中在这一屏查看。</p>
          </div>
          <div className="meta-chip-row compact align-end">
            <span className="meta-chip">{selectedConfig?.name || effectiveProviderOption.label}</span>
            <span className="meta-chip subtle">{state.resolvedModel || "尚未请求"}</span>
            <span className="meta-chip subtle">{isRunning ? "运行中" : "空闲"}</span>
          </div>
        </div>

        <section className="subtle-panel">
          <p className="section-label">当前运行摘要</p>
          <div className="info-list">
            <div>
              <span>Provider path</span>
              <strong>{configuredApiLabel}</strong>
            </div>
            <div>
              <span>Resolved model</span>
              <strong>{state.resolvedModel || "尚未请求"}</strong>
            </div>
            <div>
              <span>Thinking</span>
              <strong>{capability.reasoning ? THINKING_LEVEL_LABELS[actualThinkingLevel] : "Off"}</strong>
            </div>
          </div>
        </section>

        <section className="subtle-panel top-gap">
          <p className="section-label">Model Routing</p>
          <strong className="panel-lead">{selectedConfig?.name || effectiveProviderOption.label}</strong>
          <p className="muted-copy top-gap">
            {selectedConfig
              ? selectedConfig.kind === "openai_compatible"
                ? "Runs through the saved OpenAI-compatible endpoint config."
                : `Runs through pi-ai native routing for ${effectiveProviderOption.label}.`
              : "No reusable model config selected yet. The agent falls back to its legacy direct model fields."}
          </p>
          <div className="meta-chip-row compact top-gap">
            <span className="meta-chip subtle">{selectedConfig ? getModelConfigKindLabel(selectedConfig.kind) : effectiveProviderOption.label}</span>
            <span className="meta-chip subtle">{configuredApiLabel}</span>
            <span className="meta-chip subtle">{capability.reasoning ? `Thinking ${THINKING_LEVEL_LABELS[actualThinkingLevel]}` : "Thinking Off"}</span>
          </div>
          {selectedModelOption ? <p className="muted-copy top-gap">{selectedModelOption.summary}</p> : null}
        </section>

        <section className="subtle-panel top-gap">
          <p className="section-label">兼容策略</p>
          <strong className="panel-lead">{getCompatibilityModeLabel(state.compatibility)}</strong>
          {compatibilityPills.length > 0 ? (
            <div className="meta-chip-row compact top-gap">
              {compatibilityPills.map((pill) => (
                <span key={pill} className="meta-chip subtle">
                  {pill}
                </span>
              ))}
            </div>
          ) : (
            <p className="muted-copy top-gap">首次请求后, 这里会记录当前模型路径、thinking 映射和 provider 兼容性判断。</p>
          )}
          {state.compatibility?.notes?.length ? (
            <ul className="notes-list top-gap">
              {state.compatibility.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </section>

        <div className="card-actions compact-right top-gap">
          <button
            type="button"
            className="ghost-button"
            onClick={() => void compactAgentContext(agent.id)}
            disabled={isRunning || isCompacting}
          >
            {isCompacting ? "压缩中..." : "压缩隐藏上下文"}
          </button>
          <button type="button" className="ghost-button" onClick={() => clearAgentConsole(agent.id)} disabled={isRunning}>
            清空内部轨迹
          </button>
        </div>

        {isCompacting || compactionFeedback ? (
          <section className="subtle-panel top-gap">
            <p className="section-label">上下文压缩</p>
            <strong className="panel-lead">{isCompacting ? "正在压缩隐藏上下文" : compactionFeedback?.message}</strong>
            {compactionFeedback ? <p className="muted-copy top-gap">最近更新于 {formatTimestamp(compactionFeedback.updatedAt)}</p> : null}
            {!isCompacting && compactionFeedback?.summary ? (
              <>
                <p className="muted-copy top-gap">最近一次压缩生成的摘要如下。</p>
                <pre className="top-gap">{compactionFeedback.summary}</pre>
              </>
            ) : null}
            {!isCompacting && compactionFeedback && !compactionFeedback.summary ? <p className="muted-copy top-gap">这次没有返回可展示的压缩文本。</p> : null}
          </section>
        ) : null}
      </article>
    );
  };

  return (
    <div className="page-stack settings-page">
      <section className="hero-panel surface-panel page-enter">
        <div className="hero-copy">
          <p className="eyebrow-label">Advanced</p>
          <h1>把配置、行为和运行诊断拆开看</h1>
          <p>设置页改成更像正式后台: 先维护模型连接, 再为 Agent 指派配置, 最后单独检查运行路径与兼容策略。</p>
        </div>
        <div className="hero-actions">
          <button type="button" className={settingsTab === "models" ? "tab-button active" : "tab-button"} onClick={() => setSettingsTab("models")}>
            模型配置
          </button>
          <button type="button" className={settingsTab === "agents" ? "tab-button active" : "tab-button"} onClick={() => setSettingsTab("agents")}>
            Agent 预设
          </button>
          <button type="button" className={settingsTab === "runtime" ? "tab-button active" : "tab-button"} onClick={() => setSettingsTab("runtime")}>
            运行与诊断
          </button>
        </div>
      </section>

      <section className="surface-panel appearance-panel page-enter page-enter-delay-1">
        <div className="settings-card-header">
          <div>
            <p className="section-label">Appearance</p>
            <h2>为工作台加上昼夜切换</h2>
            <p>默认跟随系统颜色, 也可以手动锁定浅色或深色。深色模式保留现在的海绿色品牌感, 但把纸面氛围翻成夜航风格。</p>
          </div>
          <div className="meta-chip-row compact align-end">
            <span className="meta-chip">{themeMounted ? THEME_OPTION_LABELS[themePreference] : "跟随系统"}</span>
            <span className="meta-chip subtle">{themeMounted ? `当前${RESOLVED_THEME_LABELS[resolvedTheme]}` : "读取中"}</span>
          </div>
        </div>

        <div className="appearance-grid">
          <section className="subtle-panel">
            <p className="section-label">Mode</p>
            <strong className="panel-lead">把选择权给用户, 但第一次打开时先尊重设备环境。</strong>
            <div className="theme-toggle-cluster top-gap" role="group" aria-label="选择界面主题">
              {THEME_PREFERENCES.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={themePreference === option}
                  className={themePreference === option ? "theme-toggle-button active" : "theme-toggle-button"}
                  onClick={() => setThemePreference(option)}
                >
                  {THEME_OPTION_LABELS[option]}
                </button>
              ))}
            </div>
            <p className="muted-copy top-gap">
              {themeMounted
                ? `当前设备偏好是${RESOLVED_THEME_LABELS[systemTheme]}。手动模式会覆盖系统设置, 并保存在当前浏览器。`
                : "正在读取设备主题偏好。"}
            </p>

            <div className="theme-palette-grid top-gap">
              <article className="palette-card">
                <span className="palette-swatch bg" />
                <strong>海雾背景</strong>
                <p>页面底色和大面积氛围渐变。</p>
              </article>
              <article className="palette-card">
                <span className="palette-swatch panel" />
                <strong>玻璃面板</strong>
                <p>卡片、侧栏和输入容器的承载层。</p>
              </article>
              <article className="palette-card">
                <span className="palette-swatch accent" />
                <strong>潮汐青</strong>
                <p>主按钮、激活状态和运行提示。</p>
              </article>
              <article className="palette-card">
                <span className="palette-swatch warn" />
                <strong>铜琥提示</strong>
                <p>过程消息、提醒态和辅助强调。</p>
              </article>
            </div>
          </section>

          <section className="subtle-panel">
            <p className="section-label">Preview</p>
            <strong className="panel-lead">浅色保持纸面和暖雾, 深色改成低照度海面与冷玻璃。</strong>
            <div className="theme-preview-grid top-gap">
              <article className={resolvedTheme === "light" ? "theme-preview-card active" : "theme-preview-card"} data-preview="light">
                <div className="theme-preview-shell">
                  <div className="theme-preview-topline">
                    <strong>浅色</strong>
                    <span>Warm Paper</span>
                  </div>
                  <div className="theme-preview-hero" />
                  <div className="theme-preview-row">
                    <div className="theme-preview-panel" />
                    <div className="theme-preview-panel accent" />
                  </div>
                </div>
              </article>

              <article className={resolvedTheme === "dark" ? "theme-preview-card active" : "theme-preview-card"} data-preview="dark">
                <div className="theme-preview-shell">
                  <div className="theme-preview-topline">
                    <strong>深色</strong>
                    <span>Night Tide</span>
                  </div>
                  <div className="theme-preview-hero" />
                  <div className="theme-preview-row">
                    <div className="theme-preview-panel" />
                    <div className="theme-preview-panel accent" />
                  </div>
                </div>
              </article>
            </div>
            <p className="muted-copy top-gap">深色模式里的强调色会比浅色更亮一点, 这样在聊天流、状态条和输入区上更容易保持层次。</p>
          </section>
        </div>
      </section>

      {settingsTab === "models" ? (
        <section className="surface-panel page-enter page-enter-delay-1">
          <div className="settings-card-header">
            <div>
              <p className="section-label">Model Configs</p>
              <h2>独立模型配置</h2>
              <p>在这里保存可复用的模型连接。API key 只保存在服务端，不进入 workspace state 和浏览器本地缓存。</p>
            </div>
            <div className="meta-chip-row compact align-end">
              <span className="meta-chip">{loadingModelConfigs ? "Loading" : `${modelConfigs.length} configs`}</span>
              <span className="meta-chip subtle">Server-side secrets</span>
            </div>
          </div>

          <div className="settings-split-grid">
            <section className="subtle-panel config-list-panel">
              <div className="section-heading-row compact-align">
                <div>
                  <p className="section-label">Saved Configs</p>
                  <h3>选择一个配置开始编辑</h3>
                </div>
                <button type="button" className={selectedModelConfigId === NEW_MODEL_CONFIG_ID ? "tab-button active" : "tab-button"} onClick={handleCreateNewModelConfig}>
                  新建配置
                </button>
              </div>

              <div className="stacked-list compact-gap top-gap">
                {modelConfigs.map((modelConfig) => (
                  <button
                    key={modelConfig.id}
                    type="button"
                    className={selectedModelConfigId === modelConfig.id ? "config-list-button active" : "config-list-button"}
                    onClick={() => {
                      setSelectedModelConfigId(modelConfig.id);
                      setModelConfigError("");
                    }}
                  >
                    <strong>{modelConfig.name}</strong>
                    <span>{getModelConfigKindLabel(modelConfig.kind)}</span>
                    <span>{getModelConfigApiLabel(modelConfig)}</span>
                  </button>
                ))}
              </div>

              {selectedModelConfig ? (
                <div className="meta-chip-row compact top-gap">
                  <span className="meta-chip">{getModelConfigKindLabel(selectedModelConfig.kind)}</span>
                  <span className="meta-chip subtle">{getModelConfigApiLabel(selectedModelConfig)}</span>
                  <span className="meta-chip subtle">{selectedModelConfig.hasApiKey ? "API key saved" : "Using env/default"}</span>
                </div>
              ) : (
                <p className="muted-copy top-gap">新建配置后，下面的 Agent 卡片就可以直接选择它。</p>
              )}

              {modelConfigError ? <p className="muted-copy top-gap">{modelConfigError}</p> : null}
            </section>

            <section className="subtle-panel">
              <div className="section-heading-row compact-align">
                <div>
                  <p className="section-label">Editor</p>
                  <h3>{selectedModelConfigId === NEW_MODEL_CONFIG_ID ? "创建新配置" : `编辑 ${selectedModelConfig?.name || "配置"}`}</h3>
                </div>
                <div className="meta-chip-row compact align-end">
                  <span className="meta-chip subtle">{modelConfigDraft.kind === "openai_compatible" ? "Custom endpoint" : "Pi native"}</span>
                </div>
              </div>

              <form
                className="stacked-list compact-gap top-gap"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSaveModelConfig();
                }}
              >
                <div className="form-grid two-columns">
                  <label className="field-block" htmlFor="model-config-name">
                    <span>名称</span>
                    <input
                      id="model-config-name"
                      className="text-input"
                      value={modelConfigDraft.name}
                      onChange={(event) => setModelConfigDraft((current) => ({ ...current, name: event.target.value }))}
                    />
                  </label>

                  <label className="field-block" htmlFor="model-config-kind">
                    <span>类型</span>
                    <select
                      id="model-config-kind"
                      className="text-input"
                      value={modelConfigDraft.kind}
                      onChange={(event) => {
                        const nextKind = event.target.value as ModelConfigKind;
                        setModelConfigDraft((current) =>
                          nextKind === "pi_builtin"
                            ? {
                                ...current,
                                kind: nextKind,
                                model: current.kind === "pi_builtin" ? current.model : getPiDefaultModelValue(DEFAULT_PI_NATIVE_PROVIDER_ID),
                                baseUrl: "",
                                providerMode: "auto",
                                apiKey: "",
                                clearApiKey: false,
                                builtInProviderId: current.kind === "pi_builtin" ? current.builtInProviderId : DEFAULT_PI_NATIVE_PROVIDER_ID,
                              }
                            : {
                                ...current,
                                kind: nextKind,
                                model: current.kind === "openai_compatible" ? current.model : "",
                                apiFormat: current.apiFormat,
                              },
                        );
                      }}
                    >
                      <option value="openai_compatible">OpenAI-Compatible</option>
                      <option value="pi_builtin">Pi Native</option>
                    </select>
                  </label>
                </div>

                {modelConfigDraft.kind === "openai_compatible" ? (
                  <>
                    <div className="form-grid two-columns">
                      <label className="field-block" htmlFor="model-config-base-url">
                        <span>URL</span>
                        <input
                          id="model-config-base-url"
                          className="text-input"
                          value={modelConfigDraft.baseUrl}
                          onChange={(event) => setModelConfigDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                          placeholder="https://api.openai.com/v1"
                        />
                        <p className="muted-copy">留空时会使用 `OPENAI_BASE_URL`，再退回默认 OpenAI 地址。</p>
                      </label>

                      <label className="field-block" htmlFor="model-config-api-key">
                        <span>API Key</span>
                        <input
                          id="model-config-api-key"
                          type="password"
                          className="text-input"
                          value={modelConfigDraft.apiKey}
                          onChange={(event) => setModelConfigDraft((current) => ({ ...current, apiKey: event.target.value, clearApiKey: false }))}
                          placeholder="留空则保持当前值或使用 OPENAI_API_KEY"
                        />
                        <p className="muted-copy">API key 只保存在服务端。留空时会保留当前值；如果本来没有，就使用环境变量。</p>
                      </label>
                    </div>

                    <div className="form-grid two-columns">
                      <label className="field-block" htmlFor="model-config-model">
                        <span>模型名称</span>
                        <input
                          id="model-config-model"
                          className="text-input"
                          value={modelConfigDraft.model}
                          onChange={(event) => setModelConfigDraft((current) => ({ ...current, model: event.target.value }))}
                          placeholder="gpt-5.4"
                        />
                        <p className="muted-copy">可以直接填写原始 model id，留空时运行会读取 `OPENAI_MODEL`。</p>
                      </label>

                      <label className="field-block" htmlFor="model-config-provider-mode">
                        <span>兼容预设</span>
                        <select
                          id="model-config-provider-mode"
                          className="text-input"
                          value={modelConfigDraft.providerMode}
                          onChange={(event) => setModelConfigDraft((current) => ({ ...current, providerMode: event.target.value as ProviderMode }))}
                        >
                          {PROVIDER_MODE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <div className="segmented-row">
                      <button
                        type="button"
                        className={modelConfigDraft.apiFormat === "chat_completions" ? "tab-button active" : "tab-button"}
                        onClick={() => setModelConfigDraft((current) => ({ ...current, apiFormat: "chat_completions" }))}
                      >
                        OpenAI Chat Completions
                      </button>
                      <button
                        type="button"
                        className={modelConfigDraft.apiFormat === "responses" ? "tab-button active" : "tab-button"}
                        onClick={() => setModelConfigDraft((current) => ({ ...current, apiFormat: "responses" }))}
                      >
                        OpenAI Responses
                      </button>
                      <button
                        type="button"
                        className={modelConfigDraft.clearApiKey ? "tab-button active" : "tab-button"}
                        onClick={() => setModelConfigDraft((current) => ({ ...current, clearApiKey: !current.clearApiKey, apiKey: current.clearApiKey ? current.apiKey : "" }))}
                      >
                        Clear stored key
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="form-grid two-columns">
                      <label className="field-block" htmlFor="model-config-provider-family">
                        <span>Provider</span>
                        <select
                          id="model-config-provider-family"
                          className="text-input"
                          value={modelConfigDraft.builtInProviderId}
                          onChange={(event) => {
                            const nextProviderId = event.target.value as PiProviderId;
                            setModelConfigDraft((current) => ({
                              ...current,
                              builtInProviderId: nextProviderId,
                              model: getPiDefaultModelValue(nextProviderId),
                            }));
                          }}
                        >
                          {PI_NATIVE_PROVIDER_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="field-block" htmlFor="model-config-model-preset">
                        <span>模型预设</span>
                        <select
                          id="model-config-model-preset"
                          className="text-input"
                          value={
                            getPiProviderForModelValue(modelConfigDraft.model) === modelConfigDraft.builtInProviderId && getPiModelOptionByValue(modelConfigDraft.model)
                              ? modelConfigDraft.model
                              : CUSTOM_MODEL_OPTION
                          }
                          onChange={(event) => {
                            if (event.target.value === CUSTOM_MODEL_OPTION) {
                              return;
                            }

                            setModelConfigDraft((current) => ({ ...current, model: event.target.value }));
                          }}
                        >
                          {getPiModelOptions(modelConfigDraft.builtInProviderId).map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                          <option value={CUSTOM_MODEL_OPTION}>自定义模型引用</option>
                        </select>
                      </label>
                    </div>

                    <label className="field-block" htmlFor="model-config-pi-model">
                      <span>模型名称</span>
                      <input
                        id="model-config-pi-model"
                        className="text-input"
                        value={modelConfigDraft.model}
                        onChange={(event) => setModelConfigDraft((current) => ({ ...current, model: event.target.value }))}
                        placeholder={`${modelConfigDraft.builtInProviderId}/model-id`}
                      />
                      <p className="muted-copy">使用 `provider/model-id` 形式的 pi 模型引用；保存后 agent 运行时会走 pi-ai 的原生 provider 解析。</p>
                    </label>

                    <div className="meta-chip-row compact">
                      <span className="meta-chip">{getPiProviderOption(modelConfigDraft.builtInProviderId).label}</span>
                      <span className="meta-chip subtle">{getPiProviderOption(modelConfigDraft.builtInProviderId).envHint}</span>
                      <span className="meta-chip subtle">{getPiProviderOption(modelConfigDraft.builtInProviderId).apiLabel}</span>
                    </div>

                    {getPiModelOptionByValue(modelConfigDraft.model) ? <p className="muted-copy">{getPiModelOptionByValue(modelConfigDraft.model)?.summary}</p> : null}
                  </>
                )}

                <div className="card-actions compact-right">
                  {selectedModelConfigId !== NEW_MODEL_CONFIG_ID ? (
                    <button type="button" className="ghost-button" onClick={() => void handleDeleteModelConfig()} disabled={savingModelConfig}>
                      删除配置
                    </button>
                  ) : null}
                  <button type="submit" className="primary-button" disabled={savingModelConfig}>
                    {savingModelConfig ? "保存中..." : selectedModelConfigId === NEW_MODEL_CONFIG_ID ? "创建配置" : "保存修改"}
                  </button>
                </div>
              </form>
            </section>
          </div>
        </section>
      ) : null}

      {settingsTab === "agents" ? (
        <>
          <section className="surface-panel page-enter page-enter-delay-1">
            <div className="settings-card-header">
              <div>
                <p className="section-label">Agent Factory</p>
                <h2>创建新的 workspace-backed Agent</h2>
                <p>新 Agent 会立即生成自己的 workspace 文件夹和 `.agent/system-prompt.md`。</p>
              </div>
            </div>

            <div className="form-grid two-columns top-gap">
              <label className="field-block" htmlFor="new-agent-id">
                <span>Agent ID</span>
                <input id="new-agent-id" className="text-input" value={newAgentId} onChange={(event) => setNewAgentId(event.target.value)} placeholder="market-watcher" />
              </label>
              <label className="field-block" htmlFor="new-agent-label">
                <span>Label</span>
                <input
                  id="new-agent-label"
                  className="text-input"
                  value={newAgentDraft.label}
                  onChange={(event) => setNewAgentDraft((current) => ({ ...current, label: event.target.value }))}
                  placeholder="Market Watcher"
                />
              </label>
              <label className="field-block" htmlFor="new-agent-summary">
                <span>Summary</span>
                <textarea
                  id="new-agent-summary"
                  className="text-area compact"
                  value={newAgentDraft.summary}
                  onChange={(event) => setNewAgentDraft((current) => ({ ...current, summary: event.target.value }))}
                  placeholder="一句话说明这个 Agent 的主要职责。"
                />
              </label>
              <label className="field-block" htmlFor="new-agent-style">
                <span>Working Style</span>
                <textarea
                  id="new-agent-style"
                  className="text-area compact"
                  value={newAgentDraft.workingStyle}
                  onChange={(event) => setNewAgentDraft((current) => ({ ...current, workingStyle: event.target.value }))}
                  placeholder="这个 Agent 的风格、节奏和偏好。"
                />
              </label>
            </div>

            <label className="field-block top-gap" htmlFor="new-agent-skills">
              <span>Skills</span>
              <input
                id="new-agent-skills"
                className="text-input"
                value={newAgentDraft.skillsText}
                onChange={(event) => setNewAgentDraft((current) => ({ ...current, skillsText: event.target.value }))}
                placeholder="Research, Planning, Reporting"
              />
            </label>

            <label className="field-block top-gap" htmlFor="new-agent-prompt">
              <span>Private Prompt</span>
              <textarea
                id="new-agent-prompt"
                className="text-area compact"
                value={newAgentDraft.instruction}
                onChange={(event) => setNewAgentDraft((current) => ({ ...current, instruction: event.target.value }))}
                placeholder="写入这个 Agent workspace 的私有提示词。"
              />
            </label>

            {createAgentError ? <p className="muted-copy top-gap danger-text">{createAgentError}</p> : null}

            <div className="card-actions compact-right top-gap">
              <button type="button" className="ghost-button" onClick={() => void handleCreateAgent()} disabled={creatingAgent}>
                {creatingAgent ? "创建中..." : "创建 Agent"}
              </button>
            </div>
          </section>

          <section className="settings-grid page-enter page-enter-delay-1">{agents.map((agent) => renderAgentCard(agent, "agents"))}</section>
        </>
      ) : null}

      {settingsTab === "runtime" ? (
        <>
          <section className="surface-panel page-enter page-enter-delay-1">
            <div className="settings-card-header">
              <div>
                <p className="section-label">Feishu Bridge</p>
                <h2>飞书渠道调试</h2>
                <p>在这里看飞书 runtime 状态、最近入站/出站日志，以及当前本地日志文件位置。</p>
              </div>
              <div className="meta-chip-row compact align-end">
                <span className="meta-chip">{feishuRuntimeStatus?.status || "unknown"}</span>
                <span className="meta-chip subtle">{feishuRuntimeStatus?.accountId || "default"}</span>
                <span className="meta-chip subtle">{feishuRuntimeStatus?.defaultAgentId || "concierge"}</span>
              </div>
            </div>

            <section className="subtle-panel top-gap">
              <p className="section-label">Runtime Snapshot</p>
              <div className="info-list">
                <div>
                  <span>Configured</span>
                  <strong>{feishuRuntimeStatus?.configured ? "Yes" : "No"}</strong>
                </div>
                <div>
                  <span>Enabled</span>
                  <strong>{feishuRuntimeStatus?.enabled ? "Yes" : "No"}</strong>
                </div>
                <div>
                  <span>Started</span>
                  <strong>{feishuRuntimeStatus?.startedAt ? formatTimestamp(feishuRuntimeStatus.startedAt) : "Not yet"}</strong>
                </div>
                <div>
                  <span>Last inbound</span>
                  <strong>{feishuRuntimeStatus?.lastInboundAt ? formatTimestamp(feishuRuntimeStatus.lastInboundAt) : "No messages yet"}</strong>
                </div>
                <div>
                  <span>ACK reaction</span>
                  <strong>{feishuRuntimeStatus?.ackReactionEmojiType || "OK"}</strong>
                </div>
                <div>
                  <span>DONE reaction</span>
                  <strong>{feishuRuntimeStatus?.doneReactionEmojiType || "DONE"}</strong>
                </div>
              </div>

              <div className="meta-chip-row compact top-gap">
                <span className="meta-chip subtle">Status API: `/api/channels/feishu/status`</span>
                <span className="meta-chip subtle">Logs API: `/api/channels/feishu/logs`</span>
                <span className="meta-chip subtle">Backfill API: `/api/channels/feishu/backfill`</span>
                {feishuRuntimeStatus?.allowOpenIds?.length ? <span className="meta-chip subtle">Allowlist enabled</span> : <span className="meta-chip subtle">No allowlist</span>}
              </div>

              <p className="muted-copy top-gap">日志文件: <code>{feishuRuntimeLogPath || feishuRuntimeStatus?.logFilePath || "Unavailable"}</code></p>
              {feishuRuntimeStatus?.lastError ? <p className="muted-copy top-gap danger-text">{feishuRuntimeStatus.lastError}</p> : null}
              {feishuRuntimeError ? <p className="muted-copy top-gap danger-text">{feishuRuntimeError}</p> : null}
              {feishuBackfillMessage ? <p className="muted-copy top-gap">{feishuBackfillMessage}</p> : null}

              <div className="card-actions compact-right top-gap">
                <button type="button" className="ghost-button" onClick={() => void handleBackfillFeishuNicknames()} disabled={runningFeishuBackfill || loadingFeishuRuntime}>
                  {runningFeishuBackfill ? "回填中..." : "回填已有飞书昵称"}
                </button>
                <button type="button" className="ghost-button" onClick={() => void handleRefreshFeishuRuntime()} disabled={loadingFeishuRuntime}>
                  {loadingFeishuRuntime ? "刷新中..." : "刷新飞书状态"}
                </button>
              </div>
            </section>

            <section className="subtle-panel top-gap">
              <p className="section-label">Recent Events</p>
              {feishuRuntimeLogs.length > 0 ? (
                <ul className="notes-list top-gap">
                  {feishuRuntimeLogs.slice().reverse().map((entry) => (
                    <li key={entry.id}>
                      <strong>[{entry.level.toUpperCase()}]</strong> {entry.message} - {formatTimestamp(entry.timestamp)}
                      {entry.details ? <span> - <code>{JSON.stringify(entry.details)}</code></span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted-copy top-gap">还没有飞书 runtime 日志。打开状态接口或发一条飞书私聊后，这里会开始出现事件。</p>
              )}
            </section>
          </section>

          <section className="settings-grid page-enter page-enter-delay-1">{agents.map((agent) => renderAgentCard(agent, "runtime"))}</section>
        </>
      ) : null}
    </div>
  );
}
