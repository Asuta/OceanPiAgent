"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  formatTimestamp,
  getPrimaryRoomAgentId,
  getToolStats,
  useWorkspaceActions,
  useWorkspaceAgentsState,
  useWorkspaceRoomsState,
} from "@/components/workspace-provider";
import type { AgentRoomTurn, RoomAgentId, ToolExecution } from "@/lib/chat/types";

type LogFilter = "all" | "request" | "full-request" | "tool" | "system";
const ROOM_LOG_CACHE_KEY_PREFIX = "room-log-cache:";
const MAX_LOG_ENTRIES_PER_TYPE = 100;

interface RequestLogEntry {
  id: string;
  createdAt: string;
  senderName: string;
  requestText: string;
  attachmentCount: number;
  status: AgentRoomTurn["status"];
  agentLabel: string;
  modelLabel: string;
  apiFormatLabel: string;
  outputLength: number;
}

interface ToolLogEntry {
  id: string;
  createdAt: string;
  agentLabel: string;
  toolName: string;
  displayName: string;
  status: ToolExecution["status"];
  durationMs: number;
  inputSummary: string;
  resultPreview: string;
  roomActionType: string | null;
}

interface SystemLogEntry {
  id: string;
  createdAt: string;
  level: "info" | "warn" | "error";
  title: string;
  description: string;
}

interface FullRequestLogEntry {
  id: string;
  createdAt: string;
  agentLabel: string;
  promptText: string;
}

interface RoomLogCacheSnapshot {
  requestLogs: RequestLogEntry[];
  fullRequestLogs: FullRequestLogEntry[];
  toolLogs: ToolLogEntry[];
  systemLogs: SystemLogEntry[];
  ignoredRequestIds: string[];
  ignoredFullRequestIds: string[];
  ignoredToolIds: string[];
  ignoredSystemIds: string[];
}

const EMPTY_ROOM_LOG_CACHE: RoomLogCacheSnapshot = {
  requestLogs: [],
  fullRequestLogs: [],
  toolLogs: [],
  systemLogs: [],
  ignoredRequestIds: [],
  ignoredFullRequestIds: [],
  ignoredToolIds: [],
  ignoredSystemIds: [],
};

function loadRoomLogCache(roomId: string): RoomLogCacheSnapshot {
  if (typeof window === "undefined") {
    return EMPTY_ROOM_LOG_CACHE;
  }

  try {
    const rawValue = window.localStorage.getItem(`${ROOM_LOG_CACHE_KEY_PREFIX}${roomId}`);
    if (!rawValue) {
      return EMPTY_ROOM_LOG_CACHE;
    }

    const parsed = JSON.parse(rawValue) as Partial<RoomLogCacheSnapshot>;
    return {
      requestLogs: Array.isArray(parsed.requestLogs) ? parsed.requestLogs : [],
      fullRequestLogs: Array.isArray(parsed.fullRequestLogs) ? parsed.fullRequestLogs : [],
      toolLogs: Array.isArray(parsed.toolLogs) ? parsed.toolLogs : [],
      systemLogs: Array.isArray(parsed.systemLogs) ? parsed.systemLogs : [],
      ignoredRequestIds: Array.isArray(parsed.ignoredRequestIds) ? parsed.ignoredRequestIds : [],
      ignoredFullRequestIds: Array.isArray(parsed.ignoredFullRequestIds) ? parsed.ignoredFullRequestIds : [],
      ignoredToolIds: Array.isArray(parsed.ignoredToolIds) ? parsed.ignoredToolIds : [],
      ignoredSystemIds: Array.isArray(parsed.ignoredSystemIds) ? parsed.ignoredSystemIds : [],
    };
  } catch {
    return EMPTY_ROOM_LOG_CACHE;
  }
}

function mergeCachedEntries<T extends { id: string; createdAt: string }>(args: {
  cachedEntries: T[];
  nextEntries: T[];
  ignoredIds: string[];
}) {
  const knownIds = new Set(args.cachedEntries.map((entry) => entry.id));
  const ignoredIds = new Set(args.ignoredIds);
  const mergedEntries = [...args.cachedEntries];

  for (const entry of args.nextEntries) {
    if (!knownIds.has(entry.id) && !ignoredIds.has(entry.id)) {
      mergedEntries.push(entry);
    }
  }

  return mergedEntries.sort((left, right) => getSortableTime(right.createdAt) - getSortableTime(left.createdAt)).slice(0, MAX_LOG_ENTRIES_PER_TYPE);
}

function getTurnRoomId(turn: AgentRoomTurn) {
  return turn.userMessage.roomId || turn.emittedMessages[0]?.roomId || "";
}

function getSortableTime(value: string) {
  const timestamp = Date.parse(value || "");
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function truncateText(value: string, maxLength = 160) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "空内容";
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function getModelLabel(turn: AgentRoomTurn) {
  return turn.resolvedModel || turn.meta?.emptyCompletion?.resolvedModel || turn.meta?.emptyCompletion?.requestedModel || "未记录模型";
}

function getApiFormatLabel(turn: AgentRoomTurn) {
  return turn.meta?.apiFormat || turn.meta?.emptyCompletion?.apiFormat || "unknown";
}

function buildPromptText(args: {
  roomTitle: string;
  agentLabel: string;
  systemPrompt: string;
  continuationSnapshot?: string;
  userContent: string;
}) {
  const sections = [`[room] ${args.roomTitle}`, `[agent] ${args.agentLabel}`];

  if (args.systemPrompt.trim()) {
    sections.push("", "[system-prompt]", args.systemPrompt.trim());
  }

  if (args.continuationSnapshot?.trim()) {
    sections.push("", "[continuation-snapshot]", args.continuationSnapshot.trim());
  }

  sections.push("", "[user-message]", args.userContent.trim() || "<empty>");
  return sections.join("\n");
}

export function RoomLogPage({ roomId }: { roomId: string }) {
  const router = useRouter();
  const [filter, setFilter] = useState<LogFilter>("all");
  const [logCache, setLogCache] = useState<RoomLogCacheSnapshot>(() => loadRoomLogCache(roomId));
  const { activeRooms, hydrated } = useWorkspaceRoomsState();
  const { agentStates } = useWorkspaceAgentsState();
  const { getRoomById, getAgentDefinition, isRoomRunning } = useWorkspaceActions();
  const room = getRoomById(roomId);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    if (!room) {
      const fallback = activeRooms[0];
      router.replace(fallback ? `/rooms/${fallback.id}` : "/rooms");
    }
  }, [activeRooms, hydrated, room, router]);

  const roomTurns = useMemo(() => {
    if (!room) {
      return [] as AgentRoomTurn[];
    }

    if (room.agentTurns.length > 0) {
      return [...room.agentTurns].sort((left, right) => getSortableTime(right.userMessage.createdAt) - getSortableTime(left.userMessage.createdAt));
    }

    const fallbackTurns = Object.values(agentStates)
      .flatMap((state) => state.agentTurns)
      .filter((turn) => getTurnRoomId(turn) === room.id);

    return fallbackTurns.sort((left, right) => getSortableTime(right.userMessage.createdAt) - getSortableTime(left.userMessage.createdAt));
  }, [agentStates, room]);

  const requestLogs = useMemo<RequestLogEntry[]>(() => {
    return roomTurns.map((turn) => ({
      id: turn.id,
      createdAt: turn.userMessage.createdAt,
      senderName: turn.userMessage.sender.name,
      requestText: truncateText(turn.userMessage.content),
      attachmentCount: turn.userMessage.attachments.length,
      status: turn.status,
      agentLabel: turn.agent.label,
      modelLabel: getModelLabel(turn),
      apiFormatLabel: getApiFormatLabel(turn),
      outputLength: turn.assistantContent.trim().length,
    }));
  }, [roomTurns]);

  const toolLogs = useMemo<ToolLogEntry[]>(() => {
    return roomTurns.flatMap((turn) =>
      turn.tools.map((tool) => ({
        id: tool.id,
        createdAt: turn.userMessage.createdAt,
        agentLabel: turn.agent.label,
        toolName: tool.toolName,
        displayName: tool.displayName,
        status: tool.status,
        durationMs: tool.durationMs,
        inputSummary: truncateText(tool.inputSummary || tool.inputText, 120),
        resultPreview: truncateText(tool.resultPreview || tool.outputText, 120),
        roomActionType: tool.roomAction?.type ?? null,
      })),
    );
  }, [roomTurns]);

  const fullRequestLogs = useMemo<FullRequestLogEntry[]>(() => {
    if (!room) {
      return [];
    }

    return roomTurns.map((turn) => {
      const turnAgentId = turn.agent.id as RoomAgentId;
      const agentState = agentStates[turnAgentId];
      return {
        id: turn.id,
        createdAt: turn.userMessage.createdAt,
        agentLabel: turn.agent.label,
        promptText: buildPromptText({
          roomTitle: room.title,
          agentLabel: turn.agent.label,
          systemPrompt: agentState?.settings.systemPrompt || "",
          continuationSnapshot: turn.continuationSnapshot,
          userContent: turn.userMessage.content,
        }),
      };
    });
  }, [agentStates, room, roomTurns]);

  const systemLogs = useMemo<SystemLogEntry[]>(() => {
    if (!room) {
      return [];
    }

    const entries: SystemLogEntry[] = [];
    const primaryAgentId = getPrimaryRoomAgentId(room) as RoomAgentId;
    const primaryAgent = getAgentDefinition(primaryAgentId);
    const primaryAgentState = agentStates[primaryAgentId];

      entries.push({
      id: `room-status-${room.id}-${room.updatedAt}`,
      createdAt: room.updatedAt,
      level: isRoomRunning(room.id) ? "info" : "warn",
      title: isRoomRunning(room.id) ? "房间正在执行" : "房间当前空闲",
      description: `scheduler=${room.scheduler.status}，轮次=${room.scheduler.roundCount}，主 Agent=${primaryAgent.label}`,
    });

    if (primaryAgentState) {
      const toolStats = getToolStats(roomTurns.flatMap((turn) => turn.tools));
      entries.push({
        id: `agent-state-${primaryAgentId}-${primaryAgentState.updatedAt}`,
        createdAt: primaryAgentState.updatedAt,
        level: "info",
        title: "Agent 运行摘要",
        description: `resolvedModel=${primaryAgentState.resolvedModel || "未记录"}，turns=${roomTurns.length}，tools=${toolStats.total}，toolErrors=${toolStats.errorCount}`,
      });
    }

    if (room.error) {
      entries.push({
        id: `room-error-${room.id}-${room.updatedAt}`,
        createdAt: room.updatedAt,
        level: "error",
        title: "房间错误",
        description: room.error,
      });
    }

    for (const turn of roomTurns) {
      if (turn.error) {
        entries.push({
          id: `turn-error-${turn.id}`,
          createdAt: turn.userMessage.createdAt,
          level: "error",
          title: `Turn 错误 · ${turn.agent.label}`,
          description: truncateText(turn.error, 220),
        });
      }

      if (turn.meta?.emptyCompletion) {
        entries.push({
          id: `empty-completion-${turn.id}`,
          createdAt: turn.meta.emptyCompletion.createdAt,
          level: "warn",
          title: `空响应诊断 · ${turn.agent.label}`,
          description: `provider=${turn.meta.emptyCompletion.providerLabel}，model=${turn.meta.emptyCompletion.resolvedModel || "unknown"}，toolCalls=${turn.meta.emptyCompletion.toolCallCount}`,
        });
      }

      if (turn.meta?.recovery?.attempts.length) {
        entries.push({
          id: `recovery-${turn.id}`,
          createdAt: turn.userMessage.createdAt,
          level: "warn",
          title: `恢复重试 · ${turn.agent.label}`,
          description: `共 ${turn.meta.recovery.attempts.length} 次恢复尝试，最近策略=${turn.meta.recovery.attempts.at(-1)?.strategy || "unknown"}`,
        });
      }
    }

    return entries.sort((left, right) => getSortableTime(right.createdAt) - getSortableTime(left.createdAt));
  }, [agentStates, getAgentDefinition, isRoomRunning, room, roomTurns]);

  const displayedCache = useMemo<RoomLogCacheSnapshot>(() => {
    return {
      ...logCache,
      requestLogs: mergeCachedEntries({ cachedEntries: logCache.requestLogs, nextEntries: requestLogs, ignoredIds: logCache.ignoredRequestIds }),
      fullRequestLogs: mergeCachedEntries({ cachedEntries: logCache.fullRequestLogs, nextEntries: fullRequestLogs, ignoredIds: logCache.ignoredFullRequestIds }),
      toolLogs: mergeCachedEntries({ cachedEntries: logCache.toolLogs, nextEntries: toolLogs, ignoredIds: logCache.ignoredToolIds }),
      systemLogs: mergeCachedEntries({ cachedEntries: logCache.systemLogs, nextEntries: systemLogs, ignoredIds: logCache.ignoredSystemIds }),
    };
  }, [fullRequestLogs, logCache, requestLogs, systemLogs, toolLogs]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(`${ROOM_LOG_CACHE_KEY_PREFIX}${roomId}`, JSON.stringify(displayedCache));
  }, [displayedCache, roomId]);

  const displayedRequestLogs = displayedCache.requestLogs;
  const displayedFullRequestLogs = displayedCache.fullRequestLogs;
  const displayedToolLogs = displayedCache.toolLogs;
  const displayedSystemLogs = displayedCache.systemLogs;

  function clearAllLogs() {
    const nextCache: RoomLogCacheSnapshot = {
      requestLogs: [],
      fullRequestLogs: [],
      toolLogs: [],
      systemLogs: [],
      ignoredRequestIds: requestLogs.map((entry) => entry.id),
      ignoredFullRequestIds: fullRequestLogs.map((entry) => entry.id),
      ignoredToolIds: toolLogs.map((entry) => entry.id),
      ignoredSystemIds: systemLogs.map((entry) => entry.id),
    };

    setLogCache(nextCache);
  }

  const sectionCounts = {
    request: displayedRequestLogs.length,
    fullRequest: displayedFullRequestLogs.length,
    tool: displayedToolLogs.length,
    system: displayedSystemLogs.length,
  };

  if (!room) {
    return (
      <div className="page-stack">
        <section className="surface-panel empty-panel large">正在恢复日志页面...</section>
      </div>
    );
  }

  return (
    <div className="page-stack room-log-page">
      <section className="surface-panel section-panel room-log-hero page-enter">
        <div className="room-log-hero-copy">
          <p className="section-label">Log View</p>
          <h1>{room.title} 日志</h1>
          <p className="muted-copy">这里集中展示当前房间的请求日志、工具日志和系统日志，方便单独排查执行过程。</p>
        </div>

        <div className="room-log-hero-actions">
          <button type="button" className="ghost-button" onClick={clearAllLogs}>
            清空所有 Log
          </button>
          <Link href={`/rooms/${room.id}`} className="secondary-button">
            返回房间
          </Link>
        </div>
      </section>

      <section className="surface-panel section-panel page-enter page-enter-delay-1">
        <div className="section-heading-row compact-align">
          <div>
            <p className="section-label">Overview</p>
            <h2>日志页面结构预览</h2>
          </div>
          <div className="meta-chip-row compact align-end">
            <span className="meta-chip">请求 {sectionCounts.request}</span>
            <span className="meta-chip subtle">完整请求 {sectionCounts.fullRequest}</span>
            <span className="meta-chip subtle">工具 {sectionCounts.tool}</span>
            <span className="meta-chip subtle">系统 {sectionCounts.system}</span>
          </div>
        </div>

        <div className="room-log-filter-row top-gap">
          <button type="button" className={filter === "all" ? "tab-button active" : "tab-button"} onClick={() => setFilter("all")}>
            全部日志
          </button>
          <button type="button" className={filter === "request" ? "tab-button active" : "tab-button"} onClick={() => setFilter("request")}>
            请求
          </button>
          <button type="button" className={filter === "full-request" ? "tab-button active" : "tab-button"} onClick={() => setFilter("full-request")}>
            完整请求 Log
          </button>
          <button type="button" className={filter === "tool" ? "tab-button active" : "tab-button"} onClick={() => setFilter("tool")}>
            工具
          </button>
          <button type="button" className={filter === "system" ? "tab-button active" : "tab-button"} onClick={() => setFilter("system")}>
            系统
          </button>
        </div>

        <div className="trace-list top-gap">
          {(filter === "all" || filter === "request") && (
            <article className="subtle-panel room-log-card">
              <div className="section-heading-row compact-align">
                <div>
                  <p className="section-label">Section 1</p>
                  <h3>请求日志</h3>
                </div>
                <span className="meta-chip subtle">{sectionCounts.request} 条</span>
              </div>

              <p className="muted-copy">记录每一轮进入 Agent 的请求内容、发送者、模型和执行状态。</p>

              {displayedRequestLogs.length === 0 ? (
                <div className="raw-log-block room-log-placeholder top-gap">
                  <pre>当前房间还没有请求日志。</pre>
                </div>
              ) : (
                <div className="stacked-list top-gap">
                  {displayedRequestLogs.map((entry) => (
                    <article key={entry.id} className="room-log-entry request">
                      <div className="room-log-entry-topline">
                        <strong>{entry.senderName}</strong>
                        <span>{formatTimestamp(entry.createdAt)}</span>
                      </div>
                      <div className="meta-chip-row compact">
                        <span className="meta-chip subtle">{entry.agentLabel}</span>
                        <span className="meta-chip subtle">{entry.status}</span>
                        <span className="meta-chip subtle">{entry.apiFormatLabel}</span>
                        <span className="meta-chip subtle">{entry.modelLabel}</span>
                        {entry.attachmentCount > 0 ? <span className="meta-chip subtle">附件 {entry.attachmentCount}</span> : null}
                      </div>
                      <p>{entry.requestText}</p>
                      <p className="room-log-footnote">内部输出长度 {entry.outputLength} 字符</p>
                    </article>
                  ))}
                </div>
              )}
            </article>
          )}

          {(filter === "all" || filter === "full-request") && (
            <article className="subtle-panel room-log-card">
              <div className="section-heading-row compact-align">
                <div>
                  <p className="section-label">Section 2</p>
                  <h3>完整 Prompt Log</h3>
                </div>
                <span className="meta-chip subtle">{sectionCounts.fullRequest} 条</span>
              </div>

              <p className="muted-copy">这里仅展示最接近实际送模内容的完整 prompt 文本，只保留 system prompt、续跑快照和当前用户消息。</p>

              {displayedFullRequestLogs.length === 0 ? (
                <div className="raw-log-block room-log-placeholder top-gap">
                  <pre>当前房间还没有完整请求日志。</pre>
                </div>
              ) : (
                <div className="stacked-list top-gap">
                  {displayedFullRequestLogs.map((entry) => (
                    <article key={entry.id} className="room-log-entry full-request">
                      <div className="room-log-entry-topline">
                        <strong>{entry.agentLabel}</strong>
                        <span>{formatTimestamp(entry.createdAt)}</span>
                      </div>
                      <div className="meta-chip-row compact">
                        <span className="meta-chip subtle">Prompt Only</span>
                      </div>
                      <div className="raw-log-block room-log-payload-block">
                        <pre>{entry.promptText}</pre>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </article>
          )}

          {(filter === "all" || filter === "tool") && (
            <article className="subtle-panel room-log-card">
              <div className="section-heading-row compact-align">
                <div>
                  <p className="section-label">Section 3</p>
                  <h3>工具日志</h3>
                </div>
                <span className="meta-chip subtle">{sectionCounts.tool} 条</span>
              </div>

              <p className="muted-copy">按调用顺序展示工具名、状态、耗时，以及输入输出摘要。</p>

              {displayedToolLogs.length === 0 ? (
                <div className="raw-log-block room-log-placeholder top-gap">
                  <pre>当前房间还没有工具日志。</pre>
                </div>
              ) : (
                <div className="stacked-list top-gap">
                  {displayedToolLogs.map((entry) => (
                    <article key={entry.id} className="room-log-entry tool">
                      <div className="room-log-entry-topline">
                        <strong>{entry.displayName}</strong>
                        <span>{formatTimestamp(entry.createdAt)}</span>
                      </div>
                      <div className="meta-chip-row compact">
                        <span className="meta-chip subtle">{entry.agentLabel}</span>
                        <span className="meta-chip subtle">{entry.toolName}</span>
                        <span className="meta-chip subtle">{entry.status}</span>
                        <span className="meta-chip subtle">{entry.durationMs} ms</span>
                        {entry.roomActionType ? <span className="meta-chip subtle">action {entry.roomActionType}</span> : null}
                      </div>
                      <div className="room-log-pair-grid">
                        <div>
                          <p className="room-log-pair-label">输入摘要</p>
                          <p>{entry.inputSummary}</p>
                        </div>
                        <div>
                          <p className="room-log-pair-label">结果摘要</p>
                          <p>{entry.resultPreview}</p>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </article>
          )}

          {(filter === "all" || filter === "system") && (
            <article className="subtle-panel room-log-card">
              <div className="section-heading-row compact-align">
                <div>
                  <p className="section-label">Section 4</p>
                  <h3>系统日志</h3>
                </div>
                <span className="meta-chip subtle">{sectionCounts.system} 条</span>
              </div>

              <p className="muted-copy">展示房间调度、Agent 摘要、错误和恢复类事件。</p>

              {displayedSystemLogs.length === 0 ? (
                <div className="raw-log-block room-log-placeholder top-gap">
                  <pre>当前房间还没有系统日志。</pre>
                </div>
              ) : (
                <div className="stacked-list top-gap">
                  {displayedSystemLogs.map((entry) => (
                    <article key={entry.id} className={`room-log-entry system level-${entry.level}`}>
                      <div className="room-log-entry-topline">
                        <strong>{entry.title}</strong>
                        <span>{formatTimestamp(entry.createdAt)}</span>
                      </div>
                      <div className="meta-chip-row compact">
                        <span className="meta-chip subtle">{entry.level}</span>
                      </div>
                      <p>{entry.description}</p>
                    </article>
                  ))}
                </div>
              )}
            </article>
          )}
        </div>
      </section>
    </div>
  );
}
