"use client";

import { useEffect, useRef, useState } from "react";
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
  THINKING_LEVELS,
  type ApiFormat,
  type ModelConfig,
  type ModelConfigKind,
  type ProviderMode,
  type ThinkingLevel,
} from "@/lib/chat/types";
import {
  formatTimestamp,
  ROOM_AGENTS,
  getCompatibilityDetailPills,
  getCompatibilityModeLabel,
  useWorkspace,
} from "@/components/workspace-provider";

const PROVIDER_MODE_OPTIONS: Array<{ value: ProviderMode; label: string }> = [
  { value: "auto", label: "自动" },
  { value: "openai", label: "OpenAI" },
  { value: "right_codes", label: "right.codes" },
  { value: "generic", label: "通用兼容" },
];

const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
};

const CUSTOM_MODEL_OPTION = "__custom_model__";
const NEW_MODEL_CONFIG_ID = "__new_model_config__";
const DEFAULT_PI_NATIVE_PROVIDER_ID: PiProviderId = "openai";
const PI_NATIVE_PROVIDER_OPTIONS = getPiProviderOptions().filter((option) => !option.usesCustomEndpoint);

interface WorkspaceSkillSummary {
  id: string;
  title: string;
  summary: string;
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
  const {
    agentStates,
    agentCompactionFeedback,
    isAgentRunning,
    isAgentCompacting,
    clearAgentConsole,
    compactAgentContext,
    updateAgentSettings,
  } = useWorkspace();
  const [availableSkills, setAvailableSkills] = useState<WorkspaceSkillSummary[]>([]);
  const [modelConfigs, setModelConfigs] = useState<ModelConfig[]>([]);
  const [selectedModelConfigId, setSelectedModelConfigId] = useState<string>(NEW_MODEL_CONFIG_ID);
  const [modelConfigDraft, setModelConfigDraft] = useState<ModelConfigDraft>(() => ({
    ...createEmptyModelConfigDraft(),
    builtInProviderId: DEFAULT_PI_NATIVE_PROVIDER_ID,
  }));
  const [modelConfigError, setModelConfigError] = useState("");
  const [loadingModelConfigs, setLoadingModelConfigs] = useState(true);
  const [savingModelConfig, setSavingModelConfig] = useState(false);
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

      for (const agent of ROOM_AGENTS) {
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
  }, [agentStates, loadingModelConfigs, modelConfigs, updateAgentSettings]);

  const syncAgentsWithModelConfig = (modelConfig: ModelConfig) => {
    for (const agent of ROOM_AGENTS) {
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
      for (const agent of ROOM_AGENTS) {
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

  return (
    <div className="page-stack settings-page">
      <section className="hero-panel surface-panel page-enter">
        <div className="hero-copy">
          <p className="eyebrow-label">Advanced</p>
          <h1>先配模型, 再给 agent 选择</h1>
          <p>模型连接现在集中管理。Agent 页面只保留行为参数和模型配置选择, 不再在每张卡片里重复填写 URL、API key 和接口格式。</p>
        </div>
      </section>

      <section className="surface-panel page-enter page-enter-delay-1">
        <div className="settings-card-header">
          <div>
            <p className="section-label">Model Configs</p>
            <h2>独立模型配置</h2>
            <p>在这里保存可复用的模型连接。API key 只保存在服务端, 不进入 workspace state 和浏览器本地缓存。</p>
          </div>
          <div className="meta-chip-row compact align-end">
            <span className="meta-chip">{loadingModelConfigs ? "Loading" : `${modelConfigs.length} configs`}</span>
            <span className="meta-chip subtle">Server-side secrets</span>
          </div>
        </div>

        <div className="settings-grid">
          <section className="subtle-panel">
            <p className="section-label">Saved Configs</p>
            <div className="meta-chip-row compact top-gap">
              <button type="button" className={selectedModelConfigId === NEW_MODEL_CONFIG_ID ? "tab-button active" : "tab-button"} onClick={handleCreateNewModelConfig}>
                新建配置
              </button>
              {modelConfigs.map((modelConfig) => (
                <button
                  key={modelConfig.id}
                  type="button"
                  className={selectedModelConfigId === modelConfig.id ? "tab-button active" : "tab-button"}
                  onClick={() => {
                    setSelectedModelConfigId(modelConfig.id);
                    setModelConfigError("");
                  }}
                >
                  {modelConfig.name}
                </button>
              ))}
            </div>

            {selectedModelConfigId !== NEW_MODEL_CONFIG_ID ? (
              (() => {
                const selectedModelConfig = modelConfigs.find((modelConfig) => modelConfig.id === selectedModelConfigId) ?? null;
                if (!selectedModelConfig) {
                  return null;
                }

                return (
                  <div className="meta-chip-row compact top-gap">
                    <span className="meta-chip">{getModelConfigKindLabel(selectedModelConfig.kind)}</span>
                    <span className="meta-chip subtle">{getModelConfigApiLabel(selectedModelConfig)}</span>
                    <span className="meta-chip subtle">{selectedModelConfig.hasApiKey ? "API key saved" : "Using env/default"}</span>
                  </div>
                );
              })()
            ) : (
              <p className="muted-copy top-gap">新建配置后, 下面的 Agent 卡片就可以直接选择它。</p>
            )}

            {modelConfigError ? <p className="muted-copy top-gap">{modelConfigError}</p> : null}
          </section>

          <section className="subtle-panel">
            <p className="section-label">Editor</p>
            <div className="form-grid two-columns top-gap">
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
                <div className="form-grid two-columns top-gap">
                  <label className="field-block" htmlFor="model-config-base-url">
                    <span>URL</span>
                    <input
                      id="model-config-base-url"
                      className="text-input"
                      value={modelConfigDraft.baseUrl}
                      onChange={(event) => setModelConfigDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                      placeholder="https://api.openai.com/v1"
                    />
                    <p className="muted-copy">留空时会使用 `OPENAI_BASE_URL`, 再退回默认 OpenAI 地址。</p>
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
                    <p className="muted-copy">API key 只保存在服务端。留空时会保留当前值; 如果本来没有, 就使用环境变量。</p>
                  </label>
                </div>

                <div className="form-grid two-columns top-gap">
                  <label className="field-block" htmlFor="model-config-model">
                    <span>模型名称</span>
                    <input
                      id="model-config-model"
                      className="text-input"
                      value={modelConfigDraft.model}
                      onChange={(event) => setModelConfigDraft((current) => ({ ...current, model: event.target.value }))}
                      placeholder="gpt-5.4"
                    />
                    <p className="muted-copy">可以直接填写原始 model id, 留空时运行会读取 `OPENAI_MODEL`。</p>
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

                <div className="segmented-row top-gap">
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
                <div className="form-grid two-columns top-gap">
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
                        getPiProviderForModelValue(modelConfigDraft.model) === modelConfigDraft.builtInProviderId
                        && getPiModelOptionByValue(modelConfigDraft.model)
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

                <label className="field-block top-gap" htmlFor="model-config-pi-model">
                  <span>模型名称</span>
                  <input
                    id="model-config-pi-model"
                    className="text-input"
                    value={modelConfigDraft.model}
                    onChange={(event) => setModelConfigDraft((current) => ({ ...current, model: event.target.value }))}
                    placeholder={`${modelConfigDraft.builtInProviderId}/model-id`}
                  />
                  <p className="muted-copy">
                    使用 `provider/model-id` 形式的 pi 模型引用; 保存后 agent 运行时会走 pi-ai 的原生 provider 解析。
                  </p>
                </label>

                <div className="meta-chip-row compact top-gap">
                  <span className="meta-chip">{getPiProviderOption(modelConfigDraft.builtInProviderId).label}</span>
                  <span className="meta-chip subtle">{getPiProviderOption(modelConfigDraft.builtInProviderId).envHint}</span>
                  <span className="meta-chip subtle">{getPiProviderOption(modelConfigDraft.builtInProviderId).apiLabel}</span>
                </div>

                {getPiModelOptionByValue(modelConfigDraft.model) ? (
                  <p className="muted-copy top-gap">{getPiModelOptionByValue(modelConfigDraft.model)?.summary}</p>
                ) : null}
              </>
            )}

            <div className="card-actions compact-right top-gap">
              {selectedModelConfigId !== NEW_MODEL_CONFIG_ID ? (
                <button type="button" className="ghost-button" onClick={() => void handleDeleteModelConfig()} disabled={savingModelConfig}>
                  删除配置
                </button>
              ) : null}
              <button type="button" className="ghost-button" onClick={() => void handleSaveModelConfig()} disabled={savingModelConfig}>
                {savingModelConfig ? "保存中..." : selectedModelConfigId === NEW_MODEL_CONFIG_ID ? "创建配置" : "保存修改"}
              </button>
            </div>
          </section>
        </div>
      </section>

      <section className="settings-grid page-enter page-enter-delay-1">
        {ROOM_AGENTS.map((agent) => {
          const state = agentStates[agent.id];
          const compactionFeedback = agentCompactionFeedback[agent.id];
          const isRunning = isAgentRunning(agent.id);
          const isCompacting = isAgentCompacting(agent.id);
          const compatibilityPills = getCompatibilityDetailPills(state.compatibility);
          const selectedModelConfig = modelConfigs.find((modelConfig) => modelConfig.id === state.settings.modelConfigId) ?? null;
          const effectiveModelRef = selectedModelConfig?.model ?? state.settings.model;
          const effectiveApiFormat = selectedModelConfig?.apiFormat ?? state.settings.apiFormat;
          const effectiveProviderId = getPiProviderForModelValue(effectiveModelRef);
          const effectiveProviderOption = getPiProviderOption(effectiveProviderId);
          const selectedModelOption = getPiModelOptionByValue(effectiveModelRef);
          const capability = getPiThinkingCapability(effectiveModelRef);
          const actualThinkingLevel = resolveActualThinkingLevel(state.settings.thinkingLevel, capability);
          const configuredApiLabel = selectedModelConfig
            ? getModelConfigApiLabel(selectedModelConfig)
            : getPiConfiguredApiLabel(effectiveModelRef, effectiveApiFormat);

          return (
            <article key={agent.id} className="surface-panel settings-card">
              <div className="settings-card-header">
                <div>
                  <p className="section-label">Agent Preset</p>
                  <h2>{agent.label}</h2>
                  <p>{agent.summary}</p>
                </div>
                <div className="meta-chip-row compact align-end">
                  <span className="meta-chip">{selectedModelConfig?.name || "未选择模型配置"}</span>
                  <span className="meta-chip subtle">{configuredApiLabel}</span>
                  <span className="meta-chip subtle">{isRunning ? "运行中" : "空闲"}</span>
                </div>
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
                    disabled={isRunning}
                  >
                    <option value="">未选择</option>
                    {modelConfigs.map((modelConfig) => (
                      <option key={modelConfig.id} value={modelConfig.id}>
                        {modelConfig.name}
                      </option>
                    ))}
                  </select>
                  <p className="muted-copy">选择上方已经保存好的模型配置。没有的话先在上面的 Model Configs 里创建。</p>
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
                    disabled={isRunning}
                  >
                    {THINKING_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {THINKING_LEVEL_LABELS[level]}
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
                    disabled={isRunning}
                  />
                </label>

                <div className="field-block static-field">
                  <span>最近解析到的模型</span>
                  <div className="info-badge">{state.resolvedModel || "尚未请求"}</div>
                </div>
              </div>

              <label className="field-block" htmlFor={`${agent.id}-prompt`}>
                <span>System Prompt</span>
                <textarea
                  id={`${agent.id}-prompt`}
                  className="text-area compact"
                  value={state.settings.systemPrompt}
                  onChange={(event) => updateAgentSettings(agent.id, { systemPrompt: event.target.value })}
                  placeholder="为这个 Agent 增加额外的行为约束。"
                  disabled={isRunning}
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
                            disabled={isRunning}
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
                  <p className="muted-copy top-gap">当前没有发现 `skills/*/SKILL.md`。你可以在项目根目录里新增技能文件夹来扩展 prompt。</p>
                )}
              </section>

              <section className="subtle-panel top-gap">
                <p className="section-label">Model Routing</p>
                <strong className="panel-lead">{selectedModelConfig?.name || effectiveProviderOption.label}</strong>
                <p className="muted-copy top-gap">
                  {selectedModelConfig
                    ? selectedModelConfig.kind === "openai_compatible"
                      ? "Runs through the saved OpenAI-compatible endpoint config."
                      : `Runs through pi-ai native routing for ${effectiveProviderOption.label}.`
                    : "No reusable model config selected yet. The agent falls back to its legacy direct model fields."}
                </p>
                <div className="meta-chip-row compact top-gap">
                  <span className="meta-chip subtle">{selectedModelConfig ? getModelConfigKindLabel(selectedModelConfig.kind) : effectiveProviderOption.label}</span>
                  <span className="meta-chip subtle">{configuredApiLabel}</span>
                  <span className="meta-chip subtle">
                    {capability.reasoning ? `Thinking ${THINKING_LEVEL_LABELS[actualThinkingLevel]}` : "Thinking Off"}
                  </span>
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
                  {compactionFeedback ? (
                    <p className="muted-copy top-gap">
                      最近更新于 {formatTimestamp(compactionFeedback.updatedAt)}
                    </p>
                  ) : null}
                  {!isCompacting && compactionFeedback?.summary ? (
                    <>
                      <p className="muted-copy top-gap">最近一次压缩生成的摘要如下。</p>
                      <pre className="top-gap">{compactionFeedback.summary}</pre>
                    </>
                  ) : null}
                  {!isCompacting && compactionFeedback && !compactionFeedback.summary ? (
                    <p className="muted-copy top-gap">这次没有返回可展示的压缩文本。</p>
                  ) : null}
                </section>
              ) : null}
            </article>
          );
        })}
      </section>
    </div>
  );
}
