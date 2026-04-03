"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { applyModelConfigToSettings } from "@/lib/ai/model-configs";
import { useTheme } from "@/components/theme-provider";
import { formatTimestamp, getRoomPreview, useWorkspace } from "@/components/workspace-provider";
import type { ModelConfig } from "@/lib/chat/types";
import { RESOLVED_THEME_LABELS, THEME_OPTION_LABELS, THEME_PREFERENCES } from "@/lib/theme";

const MIXED_MODEL_CONFIG_VALUE = "__mixed_model_config__";
const EMPTY_MODEL_CONFIG_VALUE = "";

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
  const { mounted: themeMounted, resolvedTheme, setThemePreference, systemTheme, themePreference } = useTheme();
  const { activeRooms, agents, agentStates, archivedRooms, activeRoomId, archiveRoom, createRoom, hydrated, isRoomRunning, setActiveRoomId, updateAgentSettings } = useWorkspace();

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
