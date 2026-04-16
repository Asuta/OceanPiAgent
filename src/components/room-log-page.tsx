"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useRoomCompactionLogs, type CompactionLogEntry } from "./room-log-page-compactions";
import {
  formatTimestamp,
  getPrimaryRoomAgentId,
  getToolStats,
  useWorkspaceActions,
  useWorkspaceAgentsState,
  useWorkspaceRoomsState,
} from "@/components/workspace-provider";
import { getRoomTurnsForTimeline } from "@/components/workspace/room-thread";
import type { AgentRoomTurn, RoomAgentId, ToolExecution } from "@/lib/chat/types";

type LogFilter = "all" | "request" | "full-request" | "tool" | "system" | "compaction";
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
  compactionLogs: CompactionLogEntry[];
  ignoredRequestIds: string[];
  ignoredFullRequestIds: string[];
  ignoredToolIds: string[];
  ignoredSystemIds: string[];
  ignoredCompactionIds: string[];
}

const EMPTY_ROOM_LOG_CACHE: RoomLogCacheSnapshot = {
  requestLogs: [],
  fullRequestLogs: [],
  toolLogs: [],
  systemLogs: [],
  compactionLogs: [],
  ignoredRequestIds: [],
  ignoredFullRequestIds: [],
  ignoredToolIds: [],
  ignoredSystemIds: [],
  ignoredCompactionIds: [],
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
        compactionLogs: Array.isArray(parsed.compactionLogs) ? parsed.compactionLogs : [],
        ignoredRequestIds: Array.isArray(parsed.ignoredRequestIds) ? parsed.ignoredRequestIds : [],
        ignoredFullRequestIds: Array.isArray(parsed.ignoredFullRequestIds) ? parsed.ignoredFullRequestIds : [],
        ignoredToolIds: Array.isArray(parsed.ignoredToolIds) ? parsed.ignoredToolIds : [],
        ignoredSystemIds: Array.isArray(parsed.ignoredSystemIds) ? parsed.ignoredSystemIds : [],
        ignoredCompactionIds: Array.isArray(parsed.ignoredCompactionIds) ? parsed.ignoredCompactionIds : [],
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

function formatTokenK(value: number | undefined) {
  const safeValue = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (safeValue >= 1000) {
    return `${(safeValue / 1000).toFixed(safeValue >= 10_000 ? 0 : 1)}K`;
  }
  return `${safeValue}`;
}

function getCompactionResultLabel(result: string | undefined) {
  switch (result) {
    case "below_threshold":
      return "未超阈值";
    case "empty_context":
      return "无可压上下文";
    case "no_eligible_leaf_chunk":
      return "无可压历史块";
    case "leaf_pass_failed":
      return "叶子压缩未产出结果";
    case "no_condensation_candidate":
      return "无可继续凝缩摘要块";
    case "no_eligible_post_tool_prefix":
      return "当前 tool 批次前没有可压前缀";
    case "compacted":
      return "已压缩";
    case "compaction_failed":
      return "压缩失败";
    default:
      return "未知结果";
  }
}

function formatIdList(values: string[] | number[], emptyLabel = "无") {
  if (!values.length) {
    return emptyLabel;
  }

  const rendered = values.slice(0, 6).join(", ");
  return values.length > 6 ? `${rendered} 等 ${values.length} 项` : rendered;
}

function getCompactionTriggerLabel(trigger: CompactionLogEntry["trigger"]) {
  switch (trigger) {
    case "post_tool":
      return "post_tool";
    case "post_turn":
      return "post_turn";
    default:
      return "manual";
  }
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
  const [expandedCompactionLogIds, setExpandedCompactionLogIds] = useState<string[]>([]);
  const { activeRooms, hydrated } = useWorkspaceRoomsState();
  const { agentStates } = useWorkspaceAgentsState();
  const { getRoomById, getAgentDefinition, isRoomRunning, clearRoomLogs } = useWorkspaceActions();
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

    return [...getRoomTurnsForTimeline({ roomId: room.id, agentStates })]
      .sort((left, right) => getSortableTime(right.userMessage.createdAt) - getSortableTime(left.userMessage.createdAt));
  }, [agentStates, room]);
  const compactionLogs = useRoomCompactionLogs({ room: room ?? undefined, getAgentDefinition });

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
      compactionLogs: mergeCachedEntries({ cachedEntries: logCache.compactionLogs, nextEntries: compactionLogs, ignoredIds: logCache.ignoredCompactionIds }),
    };
  }, [compactionLogs, fullRequestLogs, logCache, requestLogs, systemLogs, toolLogs]);

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
  const displayedCompactionLogs = displayedCache.compactionLogs;

  async function clearAllLogs() {
    if (!window.confirm("确认清空这个房间的所有日志吗？这会清掉当前房间的请求、工具、完整请求、系统日志，以及相关 agent 的压缩日志。")) {
      return;
    }

    await clearRoomLogs(roomId).catch(() => null);

    const nextCache: RoomLogCacheSnapshot = {
      requestLogs: [],
      fullRequestLogs: [],
      toolLogs: [],
      systemLogs: [],
      compactionLogs: [],
      ignoredRequestIds: requestLogs.map((entry) => entry.id),
      ignoredFullRequestIds: fullRequestLogs.map((entry) => entry.id),
      ignoredToolIds: toolLogs.map((entry) => entry.id),
      ignoredSystemIds: systemLogs.map((entry) => entry.id),
      ignoredCompactionIds: compactionLogs.map((entry) => entry.id),
    };

    setLogCache(nextCache);
    setExpandedCompactionLogIds([]);
  }

  const sectionCounts = {
    request: displayedRequestLogs.length,
    fullRequest: displayedFullRequestLogs.length,
    tool: displayedToolLogs.length,
    system: displayedSystemLogs.length,
    compaction: displayedCompactionLogs.length,
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
          <button type="button" className="ghost-button" onClick={() => { void clearAllLogs(); }}>
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
            <span className="meta-chip subtle">压缩 {sectionCounts.compaction}</span>
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
          <button type="button" className={filter === "compaction" ? "tab-button active" : "tab-button"} onClick={() => setFilter("compaction")}>
            压缩
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

          {(filter === "all" || filter === "compaction") && (
            <article className="subtle-panel room-log-card">
              <div className="section-heading-row compact-align">
                <div>
                  <p className="section-label">Section 5</p>
                  <h3>压缩日志</h3>
                </div>
                <span className="meta-chip subtle">{sectionCounts.compaction} 条</span>
              </div>

              <p className="muted-copy">记录上下文压缩的触发方式、token 判断过程、压缩方法，以及每次判断的具体结论。</p>

              {displayedCompactionLogs.length === 0 ? (
                <div className="raw-log-block room-log-placeholder top-gap">
                  <pre>当前房间还没有压缩日志。</pre>
                </div>
              ) : (
                <div className="stacked-list top-gap">
                  {displayedCompactionLogs.map((entry) => (
                    <article key={entry.id} className={`room-log-entry system level-${entry.success ? "info" : "error"}`}>
                      <div className="room-log-entry-topline">
                        <strong>{entry.agentLabel}</strong>
                        <span>{formatTimestamp(entry.createdAt)}</span>
                      </div>
                      <div className="meta-chip-row compact">
                        <span className="meta-chip subtle">{getCompactionTriggerLabel(entry.trigger)}</span>
                        <span className="meta-chip subtle">{entry.success ? (entry.actionTaken ? "success" : "skipped") : "failed"}</span>
                        <span className="meta-chip subtle">
                          {entry.method === "llm" ? "大模型摘要" : entry.method === "rule_fallback" ? "程序回退摘要" : "方式未知"}
                        </span>
                        {entry.details ? <span className="meta-chip subtle">结果 {getCompactionResultLabel(entry.details.result)}</span> : null}
                        {entry.summaryRef ? <span className="meta-chip subtle">{entry.summaryRef.kind === "condensed" ? "层级摘要" : "叶子摘要"}</span> : null}
                        {entry.summaryRef ? <span className="meta-chip subtle">depth {entry.summaryRef.depth}</span> : null}
                        <span className="meta-chip subtle">pruned {entry.prunedMessages}</span>
                        <span className="meta-chip subtle">kept {entry.keptMessages}</span>
                      </div>
                      {entry.summaryRef ? (
                        <div className="room-log-pair-grid top-gap">
                          <div>
                            <p className="room-log-pair-label">摘要映射</p>
                            <p>
                              summaryId {entry.summaryRef.summaryId}，token {formatTokenK(entry.summaryRef.tokenCount)}，覆盖原始消息 {entry.summaryRef.messageIds.length} 条，
                              直接子摘要 {entry.summaryRef.childIds.length} 个。
                            </p>
                          </div>
                          <div>
                            <p className="room-log-pair-label">层级关系</p>
                            <p>
                              父摘要 {formatIdList(entry.summaryRef.parentIds)} / 子摘要 {formatIdList(entry.summaryRef.childIds)} / 原始消息 {formatIdList(entry.summaryRef.messageIds)}
                            </p>
                          </div>
                        </div>
                      ) : null}
                      {entry.details ? (
                        <div className="room-log-pair-grid top-gap">
                          <div>
                            <p className="room-log-pair-label">压缩判断</p>
                            <p>
                              判定按总估算执行：阈值 {formatTokenK(entry.details.thresholdTokens)}，当前上下文 {formatTokenK(entry.details.contextTokens)}，
                              固定开销 {formatTokenK(entry.details.promptOverheadTokens)}，总估算 {formatTokenK(entry.details.totalEstimatedTokens)}。
                            </p>
                          </div>
                          <div>
                            <p className="room-log-pair-label">开销拆分</p>
                            <p>
                              system {formatTokenK(entry.details.systemPromptTokens)} / tools {formatTokenK(entry.details.toolSchemaTokens)} / attachments {formatTokenK(entry.details.attachmentTokens)} / stored {formatTokenK(entry.details.storedContextTokens)}
                              {typeof entry.details.totalEstimatedTokensAfter === "number"
                                ? ` / 压缩后上下文 ${formatTokenK(entry.details.contextTokensAfter)} / 压缩后总估算 ${formatTokenK(entry.details.totalEstimatedTokensAfter)}`
                                : ""}
                            </p>
                          </div>
                        </div>
                      ) : null}
                      {entry.success ? (
                        entry.summary.trim() ? (
                          expandedCompactionLogIds.includes(entry.id) ? (
                            <div className="raw-log-block room-log-payload-block top-gap">
                              <pre>{entry.summary}</pre>
                            </div>
                          ) : (
                            <p>{truncateText(entry.summary, 220)}</p>
                          )
                        ) : (
                          <p>压缩完成，但没有可展示的摘要。</p>
                        )
                      ) : (
                        <p>{entry.error || "压缩失败。"}</p>
                      )}
                      {entry.success && entry.summary.trim() ? (
                        <>
                          {expandedCompactionLogIds.includes(entry.id) && entry.summaryRef ? (
                            <div className="room-log-pair-grid top-gap">
                              <div>
                                <p className="room-log-pair-label">直接映射的原始消息</p>
                                {entry.summaryRef.directMessages.length > 0 ? (
                                  <div className="raw-log-block room-log-payload-block">
                                    <pre>
                                      {entry.summaryRef.directMessages
                                        .map(
                                          (message) =>
                                            `#${message.messageId} [${message.role}] (${message.tokenCount} tokens)\n${message.preview}`,
                                        )
                                        .join("\n\n")}
                                    </pre>
                                  </div>
                                ) : (
                                  <p>这条摘要不是直接映射到原始消息，或当前没有可展示的原始消息预览。</p>
                                )}
                              </div>
                              <div>
                                <p className="room-log-pair-label">直接映射的下级摘要</p>
                                {entry.summaryRef.directChildren.length > 0 ? (
                                  <div className="raw-log-block room-log-payload-block">
                                    <pre>
                                      {entry.summaryRef.directChildren
                                        .map(
                                          (child) =>
                                            `${child.summaryId} [${child.kind}] (${child.tokenCount} tokens)\n${child.preview}`,
                                        )
                                        .join("\n\n")}
                                    </pre>
                                  </div>
                                ) : (
                                  <p>当前没有直接下级摘要。</p>
                                )}
                              </div>
                            </div>
                          ) : null}
                          {expandedCompactionLogIds.includes(entry.id) && entry.summaryRef && entry.summaryRef.subtree.length > 0 ? (
                            <div className="raw-log-block room-log-payload-block top-gap">
                              <pre>
                                {entry.summaryRef.subtree
                                  .map(
                                    (node) =>
                                      `${"  ".repeat(node.depthFromRoot)}- ${node.summaryId} [${node.kind}] depth=${node.depth} tokens=${node.tokenCount} childCount=${node.childCount} sourceTokens=${node.sourceMessageTokenCount}${node.parentSummaryId ? ` parent=${node.parentSummaryId}` : ""}`,
                                  )
                                  .join("\n")}
                                {entry.summaryRef.mappingTruncated ? "\n... 映射结果已按 token 限制截断。" : ""}
                              </pre>
                            </div>
                          ) : null}
                          <button
                            type="button"
                            className="ghost-button top-gap"
                            onClick={() => {
                              setExpandedCompactionLogIds((current) =>
                                current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id],
                              );
                            }}
                          >
                            {expandedCompactionLogIds.includes(entry.id) ? "收起完整内容与映射" : "显示完整内容与映射"}
                          </button>
                        </>
                      ) : null}
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
