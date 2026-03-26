"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatTimestamp, getRoomAgentSummary, getRoomHumanSummary, getRoomPreview, useWorkspace } from "@/components/workspace-provider";

export function RoomsOverviewPage() {
  const router = useRouter();
  const { agents, activeRooms, archivedRooms, agentStates, createRoom, archiveRoom, restoreRoom, deleteRoom, clearAllWorkspace, hydrated } = useWorkspace();
  const [isClearingAll, setIsClearingAll] = useState(false);

  const runningCount = Object.values(agentStates).filter((state) => state.agentTurns.some((turn) => turn.status === "running")).length;
  const resolvedCount = Object.values(agentStates).filter((state) => Boolean(state.resolvedModel)).length;

  return (
    <div className="page-stack">
      <section className="hero-panel surface-panel page-enter">
        <div className="hero-copy">
          <p className="eyebrow-label">Room-first</p>
          <h1>把聊天放回主舞台</h1>
          <p>
            现在首页只负责浏览和进入房间，不再把控制台、工具规则和高级配置全部堆在一个页面里。
          </p>
        </div>

        <div className="hero-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              const room = createRoom();
              router.push(`/rooms/${room.id}`);
            }}
          >
            立即开始
          </button>
          <Link href="/settings" className="secondary-button">
            查看设置
          </Link>
          <button
            type="button"
            className="ghost-button danger-text"
            disabled={isClearingAll}
            onClick={async () => {
              if (
                !window.confirm(
                  "确认一键清空所有本地房间数据吗？这会删除当前房间、活跃房间、归档房间，以及每个 Agent 的本地历史记录。",
                )
              ) {
                return;
              }

              setIsClearingAll(true);
              try {
                await clearAllWorkspace();
                router.push("/rooms");
              } finally {
                setIsClearingAll(false);
              }
            }}
          >
            {isClearingAll ? "正在清空..." : "清空本地缓存"}
          </button>
        </div>

        <div className="agent-preset-row">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="preset-chip"
              onClick={() => {
                const room = createRoom(agent.id);
                router.push(`/rooms/${room.id}`);
              }}
            >
              <strong>{agent.label}</strong>
              <span>{agent.summary}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="overview-grid page-enter page-enter-delay-1">
        <article className="metric-card surface-panel">
          <span className="metric-label">活跃房间</span>
          <strong>{hydrated ? activeRooms.length : "-"}</strong>
          <p>当前可直接进入并继续对话的房间数量。</p>
        </article>
        <article className="metric-card surface-panel">
          <span className="metric-label">归档房间</span>
          <strong>{hydrated ? archivedRooms.length : "-"}</strong>
          <p>暂时收起但仍保留本地上下文的历史房间。</p>
        </article>
        <article className="metric-card surface-panel">
          <span className="metric-label">最近有响应的 Agent</span>
          <strong>{resolvedCount}</strong>
          <p>{runningCount > 0 ? `${runningCount} 个 Agent 正在处理任务。` : "当前没有正在运行的 Agent。"}</p>
        </article>
      </section>

      <section className="section-panel surface-panel page-enter page-enter-delay-2">
        <div className="section-heading-row">
          <div>
            <p className="section-label">最近房间</p>
            <h2>继续最近的会话</h2>
          </div>
        </div>

        <div className="room-card-grid">
          {activeRooms.map((room) => (
            <article key={room.id} className="room-card">
              <div className="room-card-heading">
                <div>
                  <h3>{room.title}</h3>
                  <p>{getRoomPreview(room)}</p>
                </div>
                <span>{formatTimestamp(room.updatedAt)}</span>
              </div>

              <div className="meta-chip-row compact">
                <span className="meta-chip">{getRoomAgentSummary(room)}</span>
                <span className="meta-chip subtle">{getRoomHumanSummary(room)}</span>
                <span className="meta-chip subtle">{room.roomMessages.length} 条消息</span>
              </div>

              <div className="card-actions">
                <Link href={`/rooms/${room.id}`} className="secondary-button">
                  进入房间
                </Link>
                <button type="button" className="ghost-button" onClick={() => archiveRoom(room.id)}>
                  归档
                </button>
              </div>
            </article>
          ))}

          {activeRooms.length === 0 ? <div className="empty-panel">现在还没有活跃房间，先创建一个开始吧。</div> : null}
        </div>
      </section>

      {archivedRooms.length > 0 ? (
        <section className="section-panel surface-panel page-enter page-enter-delay-3">
          <div className="section-heading-row">
            <div>
              <p className="section-label">归档</p>
              <h2>暂存的历史房间</h2>
            </div>
          </div>

          <div className="room-card-grid archived">
            {archivedRooms.map((room) => (
              <article key={room.id} className="room-card muted">
                <div className="room-card-heading">
                  <div>
                    <h3>{room.title}</h3>
                    <p>{getRoomPreview(room)}</p>
                  </div>
                  <span>{formatTimestamp(room.updatedAt)}</span>
                </div>

                <div className="meta-chip-row compact">
                  <span className="meta-chip subtle">{getRoomAgentSummary(room)}</span>
                  <span className="meta-chip subtle">{room.roomMessages.length} 条消息</span>
                </div>

                <div className="card-actions">
                  <button type="button" className="secondary-button" onClick={() => restoreRoom(room.id)}>
                    恢复
                  </button>
                  <button
                    type="button"
                    className="ghost-button danger-text"
                    onClick={() => {
                      if (window.confirm(`确认永久删除“${room.title}”吗？此操作不可恢复。`)) {
                        deleteRoom(room.id);
                      }
                    }}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
