"use client";

import { useEffect, useState } from "react";
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

interface WorkspaceSkillSummary {
  id: string;
  title: string;
  summary: string;
}

function getThinkingNote(args: {
  modelRef: string;
  requestedThinkingLevel: ThinkingLevel;
  actualThinkingLevel: ThinkingLevel;
}) {
  const capability = getPiThinkingCapability(args.modelRef);
  if (!args.modelRef.trim()) {
    return "留空时会跟随环境变量模型；thinking 是否生效取决于最终解析到的模型能力。";
  }

  if (!capability.reasoning) {
    return "当前模型不提供 reasoning；即使设置更高等级，请求时也会按 Off 运行。";
  }

  if (args.requestedThinkingLevel !== args.actualThinkingLevel) {
    return `当前模型会把 ${THINKING_LEVEL_LABELS[args.requestedThinkingLevel]} 自动收敛到 ${THINKING_LEVEL_LABELS[args.actualThinkingLevel]}。`;
  }

  return `当前模型支持 reasoning，本轮会按 ${THINKING_LEVEL_LABELS[args.actualThinkingLevel]} 运行。`;
}

function getModelReferencePlaceholder(providerId: PiProviderId) {
  return providerId === "openai-compatible" ? "留空则使用 OPENAI_MODEL" : `${providerId}/model-id`;
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
  const providerOptions = getPiProviderOptions();
  const [availableSkills, setAvailableSkills] = useState<WorkspaceSkillSummary[]>([]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const response = await fetch("/api/skills").catch(() => null);
      if (!response?.ok) {
        return;
      }

      const payload = (await response.json().catch(() => null)) as { skills?: WorkspaceSkillSummary[] } | null;
      if (!payload?.skills || cancelled) {
        return;
      }

      setAvailableSkills(payload.skills);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page-stack settings-page">
      <section className="hero-panel surface-panel page-enter">
        <div className="hero-copy">
          <p className="eyebrow-label">Advanced</p>
          <h1>把模型编排真正交给 pi</h1>
          <p>这里统一配置多 provider、多模型、thinking level 和 OpenAI-compatible 回退模式，房间页只保留对话本身。</p>
        </div>
      </section>

      <section className="settings-grid page-enter page-enter-delay-1">
        {ROOM_AGENTS.map((agent) => {
          const state = agentStates[agent.id];
          const compactionFeedback = agentCompactionFeedback[agent.id];
          const isRunning = isAgentRunning(agent.id);
          const isCompacting = isAgentCompacting(agent.id);
          const compatibilityPills = getCompatibilityDetailPills(state.compatibility);
          const providerId = getPiProviderForModelValue(state.settings.model);
          const providerOption = getPiProviderOption(providerId);
          const modelOptions = getPiModelOptions(providerId);
          const selectedModelOption = getPiModelOptionByValue(state.settings.model);
          const modelSelectValue = selectedModelOption?.value ?? CUSTOM_MODEL_OPTION;
          const capability = getPiThinkingCapability(state.settings.model);
          const actualThinkingLevel = resolveActualThinkingLevel(state.settings.thinkingLevel, capability);
          const configuredApiLabel = getPiConfiguredApiLabel(state.settings.model, state.settings.apiFormat);
          const usesCustomEndpoint = providerOption.usesCustomEndpoint;

          return (
            <article key={agent.id} className="surface-panel settings-card">
              <div className="settings-card-header">
                <div>
                  <p className="section-label">Agent Preset</p>
                  <h2>{agent.label}</h2>
                  <p>{agent.summary}</p>
                </div>
                <div className="meta-chip-row compact align-end">
                  <span className="meta-chip">{providerOption.label}</span>
                  <span className="meta-chip subtle">{configuredApiLabel}</span>
                  <span className="meta-chip subtle">{isRunning ? "运行中" : "空闲"}</span>
                </div>
              </div>

              <div className="form-grid two-columns">
                <label className="field-block" htmlFor={`${agent.id}-provider-family`}>
                  <span>Provider</span>
                  <select
                    id={`${agent.id}-provider-family`}
                    className="text-input"
                    value={providerId}
                    onChange={(event) => {
                      const nextProviderId = event.target.value as PiProviderId;
                      updateAgentSettings(agent.id, {
                        model:
                          nextProviderId === "openai-compatible"
                            ? providerId === "openai-compatible"
                              ? state.settings.model
                              : ""
                            : getPiDefaultModelValue(nextProviderId),
                        ...(nextProviderId === "openai-compatible"
                          ? {}
                          : {
                              providerMode: "auto",
                            }),
                      });
                    }}
                    disabled={isRunning}
                  >
                    {providerOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field-block" htmlFor={`${agent.id}-model-preset`}>
                  <span>模型预设</span>
                  <select
                    id={`${agent.id}-model-preset`}
                    className="text-input"
                    value={modelSelectValue}
                    onChange={(event) => {
                      if (event.target.value === CUSTOM_MODEL_OPTION) {
                        return;
                      }

                      updateAgentSettings(agent.id, {
                        model: event.target.value,
                      });
                    }}
                    disabled={isRunning}
                  >
                    {modelOptions.map((option) => (
                      <option key={option.value || "env-default"} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                    <option value={CUSTOM_MODEL_OPTION}>自定义模型引用</option>
                  </select>
                </label>

                <label className="field-block" htmlFor={`${agent.id}-model-ref`}>
                  <span>模型引用</span>
                  <input
                    id={`${agent.id}-model-ref`}
                    className="text-input"
                    value={state.settings.model}
                    onChange={(event) => updateAgentSettings(agent.id, { model: event.target.value })}
                    placeholder={getModelReferencePlaceholder(providerId)}
                    disabled={isRunning}
                  />
                  <p className="muted-copy">
                    {usesCustomEndpoint
                      ? "直接填写原始 model id；留空时会读取 OPENAI_MODEL。"
                      : "使用 provider/model-id 形式的 pi 模型引用；选择预设会自动填充。"}
                  </p>
                </label>

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
                      modelRef: state.settings.model,
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

              {usesCustomEndpoint ? (
                <>
                  <div className="segmented-row">
                    <button
                      type="button"
                      className={state.settings.apiFormat === "chat_completions" ? "tab-button active" : "tab-button"}
                      onClick={() => updateAgentSettings(agent.id, { apiFormat: "chat_completions" })}
                      disabled={isRunning}
                    >
                      Chat Completions
                    </button>
                    <button
                      type="button"
                      className={state.settings.apiFormat === "responses" ? "tab-button active" : "tab-button"}
                      onClick={() => updateAgentSettings(agent.id, { apiFormat: "responses" })}
                      disabled={isRunning}
                    >
                      Responses
                    </button>
                  </div>

                  <label className="field-block" htmlFor={`${agent.id}-provider-mode`}>
                    <span>兼容预设</span>
                    <select
                      id={`${agent.id}-provider-mode`}
                      className="text-input"
                      value={state.settings.providerMode}
                      onChange={(event) => updateAgentSettings(agent.id, { providerMode: event.target.value as ProviderMode })}
                      disabled={isRunning}
                    >
                      {PROVIDER_MODE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}

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
                <p className="section-label">Pi Routing</p>
                <strong className="panel-lead">{providerOption.label}</strong>
                <p className="muted-copy top-gap">{providerOption.description}</p>
                <div className="meta-chip-row compact top-gap">
                  <span className="meta-chip subtle">{providerOption.envHint}</span>
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
                  <p className="muted-copy top-gap">首次请求后，这里会记录当前模型路径、thinking 映射和 provider 兼容性判断。</p>
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
