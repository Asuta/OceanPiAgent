"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { applyModelConfigToSettings } from "@/lib/ai/model-configs";
import { useTheme } from "@/components/theme-provider";
import { formatTimestamp, getRoomPreview, useWorkspaceActions, useWorkspaceAgentsState, useWorkspaceRoomsState } from "@/components/workspace-provider";
import { coerceCompactionFreshTailCount, coerceCompactionTokenThreshold, DEFAULT_COMPACTION_FRESH_TAIL_COUNT, DEFAULT_COMPACTION_TOKEN_THRESHOLD } from "@/lib/chat/types";
import type { ModelConfig } from "@/lib/chat/types";
import { RESOLVED_THEME_LABELS, THEME_OPTION_LABELS, THEME_PREFERENCES } from "@/lib/theme";

const MIXED_MODEL_CONFIG_VALUE = "__mixed_model_config__";
const MIXED_COMPACTION_THRESHOLD_VALUE = "__mixed_compaction_threshold__";
const MIXED_FRESH_TRAIL_COUNT_VALUE = "__mixed_fresh_trail_count__";
const EMPTY_MODEL_CONFIG_VALUE = "";

type AgentPromptBaseline = {
  agentId: string;
  promptOverheadTokens: number;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  attachmentTokens: number;
};

function formatCompactionThreshold(value: number): string {
  if (value >= 1000 && value % 1000 === 0) {
    return `${value / 1000}K`;
  }
  return `${value}`;
}

function parseCompactionThresholdInput(value: string): number | null {
  const normalized = value.trim().toLowerCase().replace(/,/g, "");
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([km]?)$/);
  if (!match) {
    return null;
  }

  const numericValue = Number(match[1]);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  return Math.round(numericValue * multiplier);
}

function formatFreshTrailCount(value: number): string {
  return `${value}`;
}

function parseFreshTrailCountInput(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  return coerceCompactionFreshTailCount(Number(normalized));
}

async function fetchModelConfigs(): Promise<ModelConfig[]> {
  const response = await fetch("/api/model-configs", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to load model configs.");
  }

  const payload = (await response.json().catch(() => null)) as { modelConfigs?: ModelConfig[] } | null;
  return [...(payload?.modelConfigs ?? [])].sort(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name),
  );
}

function getShellTitle(pathname: string) {
  if (pathname.startsWith("/settings")) {
    return {
      title: "工作台设置",
      subtitle: "把高级配置移到独立页面，让聊天界面保持干净。",
    };
  }

  if (pathname.startsWith("/rooms/")) {
    return {
      title: "房间会话",
      subtitle: "以房间为主任务，需要时再展开执行细节。",
    };
  }

  return {
    title: "房间总览",
    subtitle: "快速浏览活跃会话、归档房间和最近状态。",
  };
}

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modelConfigs, setModelConfigs] = useState<ModelConfig[]>([]);
  const [loadingModelConfigs, setLoadingModelConfigs] = useState(true);
  const [compactionThresholdInput, setCompactionThresholdInput] = useState("");
  const [freshTrailCountInput, setFreshTrailCountInput] = useState("");
  const [agentPromptBaselines, setAgentPromptBaselines] = useState<AgentPromptBaseline[]>([]);
  const { mounted: themeMounted, resolvedTheme, setThemePreference, systemTheme, themePreference } = useTheme();
  const { activeRooms, archivedRooms, activeRoomId, hydrated } = useWorkspaceRoomsState();
  const { agents, agentStates } = useWorkspaceAgentsState();
  const { archiveRoom, createRoom, isRoomRunning, setActiveRoomId, updateAgentSettings } = useWorkspaceActions();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const nextModelConfigs = await fetchModelConfigs();
        if (!cancelled) {
          setModelConfigs(nextModelConfigs);
        }
      } catch {
        if (!cancelled) {
          setModelConfigs([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingModelConfigs(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const shellTitle = useMemo(() => getShellTitle(pathname), [pathname]);
  const activeTopbarRoomId = useMemo(() => {
    if (!pathname.startsWith("/rooms/")) {
      return "";
    }

    return pathname.split("/")[2] ?? "";
  }, [pathname]);
  const globalModelConfigValue = useMemo(() => {
    if (agents.length === 0) {
      return EMPTY_MODEL_CONFIG_VALUE;
    }

    const configuredIds = new Set(
      agents.map((agent) => {
        const modelConfigId = agentStates[agent.id]?.settings.modelConfigId;
        return typeof modelConfigId === "string" && modelConfigId.trim() ? modelConfigId : EMPTY_MODEL_CONFIG_VALUE;
      }),
    );

    if (configuredIds.size !== 1) {
      return MIXED_MODEL_CONFIG_VALUE;
    }

    return [...configuredIds][0] ?? EMPTY_MODEL_CONFIG_VALUE;
  }, [agentStates, agents]);
  const selectedGlobalModelConfig = useMemo(() => {
    if (!globalModelConfigValue || globalModelConfigValue === MIXED_MODEL_CONFIG_VALUE) {
      return null;
    }

    return modelConfigs.find((modelConfig) => modelConfig.id === globalModelConfigValue) ?? null;
  }, [globalModelConfigValue, modelConfigs]);
  const globalCompactionThresholdValue = useMemo(() => {
    if (agents.length === 0) {
      return DEFAULT_COMPACTION_TOKEN_THRESHOLD;
    }

    const thresholds = new Set(
      agents.map((agent) => coerceCompactionTokenThreshold(agentStates[agent.id]?.settings.compactionTokenThreshold)),
    );

    if (thresholds.size !== 1) {
      return MIXED_COMPACTION_THRESHOLD_VALUE;
    }

    return [...thresholds][0] ?? DEFAULT_COMPACTION_TOKEN_THRESHOLD;
  }, [agentStates, agents]);
  const globalFreshTrailCountValue = useMemo(() => {
    if (agents.length === 0) {
      return DEFAULT_COMPACTION_FRESH_TAIL_COUNT;
    }

    const counts = new Set(
      agents.map((agent) => coerceCompactionFreshTailCount(agentStates[agent.id]?.settings.compactionFreshTailCount)),
    );

    if (counts.size !== 1) {
      return MIXED_FRESH_TRAIL_COUNT_VALUE;
    }

    return [...counts][0] ?? DEFAULT_COMPACTION_FRESH_TAIL_COUNT;
  }, [agentStates, agents]);
  const maxPromptOverheadTokens = useMemo(
    () => agentPromptBaselines.reduce((maxValue, baseline) => Math.max(maxValue, baseline.promptOverheadTokens), 0),
    [agentPromptBaselines],
  );
  const compactionThresholdWarning = useMemo(() => {
    if (typeof globalCompactionThresholdValue !== "number" || maxPromptOverheadTokens <= 0) {
      return "";
    }

    if (globalCompactionThresholdValue >= maxPromptOverheadTokens) {
      return "";
    }

    return `当前阈值低于至少一个 agent 的当前 prompt 固定开销（约 ${formatCompactionThreshold(maxPromptOverheadTokens)}），自动压缩无法将总请求降到该值以下。`;
  }, [globalCompactionThresholdValue, maxPromptOverheadTokens]);
  const sidebarRooms = useMemo(() => {
    if (!hydrated || activeRooms.length === 0) {
      return [];
    }

    const currentPathRoomId = pathname.startsWith("/rooms/") ? pathname.split("/")[2] ?? "" : activeRoomId;
    const pinned = currentPathRoomId ? activeRooms.find((room) => room.id === currentPathRoomId) : null;
    const recent = activeRooms.filter((room) => room.id !== pinned?.id);

    return pinned ? [pinned, ...recent] : activeRooms;
  }, [activeRoomId, activeRooms, hydrated, pathname]);
  const handleArchiveRoom = useCallback(
    (roomId: string, roomTitle: string) => {
      if (!window.confirm(`确认归档“${roomTitle}”吗？归档后它会从最近房间中移除，但仍可在总览页恢复。`)) {
        return;
      }

      void archiveRoom(roomId);
    },
    [archiveRoom],
  );
  const handleGlobalModelConfigChange = useCallback(
    (nextModelConfigId: string) => {
      const nextModelConfig = modelConfigs.find((modelConfig) => modelConfig.id === nextModelConfigId);
      if (!nextModelConfig) {
        return;
      }

      for (const agent of agents) {
        const state = agentStates[agent.id];
        if (!state) {
          continue;
        }

        updateAgentSettings(agent.id, applyModelConfigToSettings(state.settings, nextModelConfig));
      }
    },
    [agentStates, agents, modelConfigs, updateAgentSettings],
  );
  const handleGlobalCompactionThresholdChange = useCallback(
    (nextValue: number) => {
      const nextThreshold = coerceCompactionTokenThreshold(nextValue);
      for (const agent of agents) {
        updateAgentSettings(agent.id, { compactionTokenThreshold: nextThreshold });
      }
    },
    [agents, updateAgentSettings],
  );
  const handleGlobalFreshTrailCountChange = useCallback(
    (nextValue: number) => {
      const nextCount = coerceCompactionFreshTailCount(nextValue);
      for (const agent of agents) {
        updateAgentSettings(agent.id, { compactionFreshTailCount: nextCount });
      }
    },
    [agents, updateAgentSettings],
  );

  useEffect(() => {
    if (globalCompactionThresholdValue === MIXED_COMPACTION_THRESHOLD_VALUE) {
      setCompactionThresholdInput("");
      return;
    }

    setCompactionThresholdInput(formatCompactionThreshold(globalCompactionThresholdValue));
  }, [globalCompactionThresholdValue]);

  useEffect(() => {
    if (globalFreshTrailCountValue === MIXED_FRESH_TRAIL_COUNT_VALUE) {
      setFreshTrailCountInput("");
      return;
    }

    setFreshTrailCountInput(formatFreshTrailCount(globalFreshTrailCountValue));
  }, [globalFreshTrailCountValue]);

  useEffect(() => {
    if (agents.length === 0) {
      setAgentPromptBaselines([]);
      return;
    }

    let cancelled = false;
    const query = new URLSearchParams();
    for (const agent of agents) {
      query.append("agentId", agent.id);
    }

    void (async () => {
      const response = await fetch(`/api/agent-runtime/prompt-baseline?${query.toString()}`, { cache: "no-store" }).catch(() => null);
      if (!response?.ok) {
        if (!cancelled) {
          setAgentPromptBaselines([]);
        }
        return;
      }

      const payload = (await response.json().catch(() => null)) as { baselines?: AgentPromptBaseline[] } | null;
      if (!cancelled) {
        setAgentPromptBaselines(Array.isArray(payload?.baselines) ? payload.baselines : []);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agentStates, agents]);

  return (
    <div className={`app-shell${sidebarOpen ? " sidebar-open" : ""}`}>
      <aside className="app-sidebar">
        <section className="sidebar-overview-panel surface-panel">
          <div className="sidebar-brand">
            <div>
              <p className="eyebrow-label">OceanKing</p>
              <h1>Room Workspace</h1>
            </div>
            <p className="sidebar-copy">更清晰的房间工作台：总览、聊天、设置分层展开。</p>
          </div>

          <button
            type="button"
            className="primary-button sidebar-create-button"
            onClick={() => {
              void (async () => {
                const room = await createRoom();
                if (!room) {
                  return;
                }
                setSidebarOpen(false);
                router.push(`/rooms/${room.id}`);
              })();
            }}
          >
            新建房间
          </button>

          <nav className="sidebar-nav" aria-label="主导航">
            <Link href="/rooms" className={pathname === "/rooms" ? "nav-link active" : "nav-link"} onClick={() => setSidebarOpen(false)}>
              房间总览
            </Link>
            <Link
              href="/settings"
              className={pathname.startsWith("/settings") ? "nav-link active" : "nav-link"}
              onClick={() => setSidebarOpen(false)}
            >
              工作台设置
            </Link>
          </nav>
        </section>

        <section className="sidebar-section sidebar-rooms-panel surface-panel">
          <div className="section-heading-row">
            <div className="sidebar-section-heading">
              <p className="section-label">最近房间</p>
              <strong>{hydrated ? `${activeRooms.length} 个活跃会话` : "加载中"}</strong>
            </div>
            <Link href="/rooms" className="mini-button" onClick={() => setSidebarOpen(false)}>
              查看总览
            </Link>
          </div>

          <div className="sidebar-rooms-scroll">
            <div className="sidebar-room-list">
              {hydrated ? (
                sidebarRooms.map((room) => {
                  const active = pathname === `/rooms/${room.id}` || (pathname === "/rooms" && room.id === activeRoomId);
                  const isRunning = isRoomRunning(room.id);
                  return (
                    <article key={room.id} className={active ? "sidebar-room-card active" : "sidebar-room-card"}>
                      <Link
                        href={`/rooms/${room.id}`}
                        className="sidebar-room-card-link"
                        onClick={() => {
                          setActiveRoomId(room.id);
                          setSidebarOpen(false);
                        }}
                      >
                        <div className="sidebar-room-topline">
                          <strong>{room.title}</strong>
                          <span>{formatTimestamp(room.updatedAt)}</span>
                        </div>
                        <p>{getRoomPreview(room)}</p>
                      </Link>
                      <div className="sidebar-room-actions">
                        <button
                          type="button"
                          className="mini-button"
                          disabled={isRunning}
                          onClick={() => handleArchiveRoom(room.id, room.title)}
                        >
                          归档
                        </button>
                      </div>
                    </article>
                  );
                })
              ) : (
                <div className="sidebar-empty-card">正在恢复本地房间...</div>
              )}
            </div>

            {archivedRooms.length > 0 ? (
              <details className="sidebar-disclosure">
                <summary>归档房间 {archivedRooms.length}</summary>
                <div className="sidebar-room-list compact">
                  {archivedRooms.map((room) => (
                    <button
                      key={room.id}
                      type="button"
                      className="sidebar-room-card muted"
                      onClick={() => {
                        setActiveRoomId(room.id);
                        router.push("/rooms");
                        setSidebarOpen(false);
                      }}
                    >
                      <div className="sidebar-room-topline">
                        <strong>{room.title}</strong>
                        <span>{formatTimestamp(room.updatedAt)}</span>
                      </div>
                      <p>{getRoomPreview(room)}</p>
                    </button>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        </section>
      </aside>

      <div className="app-main-frame">
        <header className="app-topbar">
          <button type="button" className="icon-button sidebar-toggle" onClick={() => setSidebarOpen((value) => !value)}>
            {sidebarOpen ? "关闭" : "菜单"}
          </button>
          <div className="topbar-copy">
            <p className="eyebrow-label">Workspace</p>
            <h2>{shellTitle.title}</h2>
            <p>{shellTitle.subtitle}</p>
          </div>
          <div className="topbar-actions">
            {activeTopbarRoomId ? (
              <Link href={`/rooms/${activeTopbarRoomId}/logs`} className="secondary-button">
                Log
              </Link>
            ) : null}
            <label className="topbar-model-switcher" aria-label="切换所有 agent 的模型配置">
              <span className="eyebrow-label">Agent 模型</span>
              <select
                className="text-input topbar-model-select"
                value={globalModelConfigValue}
                disabled={loadingModelConfigs || modelConfigs.length === 0}
                onChange={(event) => handleGlobalModelConfigChange(event.target.value)}
              >
                {loadingModelConfigs ? <option value="">加载模型配置中...</option> : null}
                {!loadingModelConfigs && modelConfigs.length === 0 ? <option value="">先去设置页添加模型配置</option> : null}
                {globalModelConfigValue === MIXED_MODEL_CONFIG_VALUE ? <option value={MIXED_MODEL_CONFIG_VALUE}>当前 agent 使用不同模型</option> : null}
                {globalModelConfigValue && globalModelConfigValue !== MIXED_MODEL_CONFIG_VALUE && !selectedGlobalModelConfig ? (
                  <option value={globalModelConfigValue}>当前配置已不存在</option>
                ) : null}
                {modelConfigs.map((modelConfig) => (
                  <option key={modelConfig.id} value={modelConfig.id}>
                    {modelConfig.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="topbar-model-switcher" aria-label="统一设置自动压缩阈值">
              <span className="eyebrow-label">压缩阈值</span>
              <input
                type="text"
                inputMode="numeric"
                className="text-input topbar-model-select"
                value={compactionThresholdInput}
                placeholder={globalCompactionThresholdValue === MIXED_COMPACTION_THRESHOLD_VALUE ? "当前不一致" : "例如 200K"}
                onChange={(event) => setCompactionThresholdInput(event.target.value)}
                onBlur={() => {
                  const parsedValue = parseCompactionThresholdInput(compactionThresholdInput);
                  if (parsedValue == null) {
                    setCompactionThresholdInput(
                      globalCompactionThresholdValue === MIXED_COMPACTION_THRESHOLD_VALUE
                        ? ""
                        : formatCompactionThreshold(globalCompactionThresholdValue),
                    );
                    return;
                  }

                  handleGlobalCompactionThresholdChange(parsedValue);
                }}
              />
              {compactionThresholdWarning ? <span className="topbar-inline-warning">{compactionThresholdWarning}</span> : null}
            </label>
            <label className="topbar-model-switcher" aria-label="统一设置压缩时保留的 fresh trail 消息数">
              <span className="eyebrow-label">Fresh Trail</span>
              <input
                type="text"
                inputMode="numeric"
                className="text-input topbar-model-select"
                value={freshTrailCountInput}
                placeholder={globalFreshTrailCountValue === MIXED_FRESH_TRAIL_COUNT_VALUE ? "当前不一致" : "0 表示不保留"}
                onChange={(event) => setFreshTrailCountInput(event.target.value)}
                onBlur={() => {
                  const parsedValue = parseFreshTrailCountInput(freshTrailCountInput);
                  if (parsedValue == null) {
                    setFreshTrailCountInput(
                      globalFreshTrailCountValue === MIXED_FRESH_TRAIL_COUNT_VALUE
                        ? ""
                        : formatFreshTrailCount(globalFreshTrailCountValue),
                    );
                    return;
                  }

                  handleGlobalFreshTrailCountChange(parsedValue);
                }}
              />
            </label>
            <div className="theme-toggle-cluster compact" role="group" aria-label="切换浅色和深色模式">
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
            <span className="meta-chip subtle theme-status-chip">
              {themeMounted
                ? themePreference === "system"
                  ? `系统${RESOLVED_THEME_LABELS[systemTheme]}`
                  : `当前${RESOLVED_THEME_LABELS[resolvedTheme]}`
                : "外观"}
            </span>
            <span className="meta-chip subtle theme-status-chip">
              {loadingModelConfigs
                ? "模型加载中"
                : globalModelConfigValue === MIXED_MODEL_CONFIG_VALUE
                  ? "当前未统一"
                  : selectedGlobalModelConfig?.name || "未配置模型"}
            </span>
          </div>
        </header>

        <main className="workspace-view">{children}</main>
      </div>

      <button type="button" aria-label="关闭侧边栏" className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />
    </div>
  );
}
