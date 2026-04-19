"use client";

import type { CSSProperties } from "react";
import { useAgentWorldState } from "@/components/workspace/use-agent-world-state";
import { formatTimestamp } from "@/components/workspace-provider";
import type { AgentSharedState, RoomAgentDefinition, RoomAgentId, RoomSession, WorkspaceRuntimeState } from "@/lib/chat/types";

function getWorldSummary(status: string) {
  switch (status) {
    case "working":
      return "走到自己的工位上，用电脑处理工具任务";
    default:
      return "在休息区里慢慢晃，聊聊天也算休息状态";
  }
}

export function AgentWorldPanel(props: {
  agents: RoomAgentDefinition[];
  rooms: RoomSession[];
  agentStates: Record<RoomAgentId, AgentSharedState>;
  runtimeState?: WorkspaceRuntimeState;
  currentRoomId?: string;
}) {
  const snapshot = useAgentWorldState({
    agents: props.agents,
    rooms: props.rooms,
    agentStates: props.agentStates,
    runtimeState: props.runtimeState,
    currentRoomId: props.currentRoomId,
  });

  const onlineCount = snapshot.agents.filter((agent) => agent.isOnline).length;
  const workingCount = snapshot.agents.filter((agent) => agent.status === "working").length;
  const restingCount = snapshot.agents.length - workingCount;
  const currentRoomCount = snapshot.agents.filter((agent) => agent.isCurrentRoomParticipant).length;

  return (
    <div className="inspector-stack">
      <section className="subtle-panel agent-world-panel">
        <div className="section-heading-row compact-align">
          <div>
            <p className="section-label">Pixel Office</p>
            <h3>两个房间，两种心情</h3>
            <p className="muted-copy">这里只有休息区和工作区。只有真的在跑工具时，小人才会走到自己的电脑前；其他时候都留在休息区里闲逛。</p>
          </div>
          <div className="meta-chip-row compact align-end">
            <span className="meta-chip">{onlineCount} 在线</span>
            <span className="meta-chip subtle">{workingCount} 工作中</span>
            <span className="meta-chip subtle">{restingCount} 休息中</span>
            <span className="meta-chip subtle">当前房间 {currentRoomCount}</span>
          </div>
        </div>

        <div className="agent-world-stage playful" role="img" aria-label="A playful pixel office showing agents wandering in the lounge or working at their desks.">
          <div className="agent-world-stage-backdrop" aria-hidden="true" />
          {snapshot.zones.map((zone) => (
            <div
              key={zone.id}
              className={`agent-world-zone zone-${zone.id}`}
              style={{
                left: `${zone.x}%`,
                top: `${zone.y}%`,
                width: `${zone.width}%`,
                height: `${zone.height}%`,
              }}
            >
              <span>{zone.shortLabel}</span>
              <strong>{zone.label}</strong>
            </div>
          ))}

          {snapshot.agents.map((agent) => (
            <div
              key={`${agent.agentId}-desk`}
              className={`agent-world-desk${agent.isCurrentRoomParticipant ? " is-current-room" : ""}`}
              style={{
                left: `${agent.desk.x}%`,
                top: `${agent.desk.y}%`,
              }}
              aria-hidden="true"
            >
              <span className="agent-world-monitor" />
              <span className="agent-world-chair" />
            </div>
          ))}

          {snapshot.agents.map((agent) => (
            <article
              key={agent.agentId}
              className={`agent-world-agent status-${agent.status}${agent.isCurrentRoomParticipant ? " is-current-room" : ""}`}
              style={
                {
                  left: `${agent.target.x}%`,
                  top: `${agent.target.y}%`,
                  "--agent-hue": `${(agent.colorSeed * 47) % 360}deg`,
                  "--agent-travel-duration": `${agent.movementDurationMs}ms`,
                } as CSSProperties
              }
            >
              <span className="agent-world-agent-shadow" aria-hidden="true" />
              <span className="agent-world-agent-sprite" aria-hidden="true">
                <span className="agent-world-head" />
                <span className="agent-world-body" />
              </span>
              <span className="agent-world-agent-name">{agent.label}</span>
              {agent.pulse ? <span className={`agent-world-pulse pulse-${agent.pulse.kind}`}>{agent.pulse.label}</span> : null}
            </article>
          ))}
        </div>

        <div className="agent-world-legend">
          <span className="meta-chip subtle">休息区: 没在跑工具时，小人会在这里自由走动</span>
          <span className="meta-chip subtle">工作区: 每个 Agent 都有自己的固定工位和电脑</span>
          <span className="meta-chip subtle">说话气泡: 纯文本对话只冒气泡，不会把它切进工作状态</span>
        </div>
      </section>

      <section className="subtle-panel">
        <div className="section-heading-row compact-align">
          <div>
            <p className="section-label">Roster</p>
            <h3>今天谁在摸鱼，谁在开工</h3>
          </div>
          <span className="composer-note">最近更新于 {formatTimestamp(snapshot.generatedAt)}</span>
        </div>

        <div className="agent-world-roster">
          {snapshot.agents.map((agent) => (
            <article key={`${agent.agentId}-card`} className={`agent-world-card status-${agent.status}`}>
              <div className="agent-world-card-topline">
                <div>
                  <strong>{agent.label}</strong>
                  <p>{agent.summary}</p>
                </div>
                <div className="meta-chip-row compact align-end">
                  <span className="meta-chip">{agent.statusLabel}</span>
                  {agent.isCurrentRoomParticipant ? <span className="meta-chip subtle">当前房间</span> : null}
                </div>
              </div>
              <p className="agent-world-card-summary">{getWorldSummary(agent.status)}</p>
              <div className="meta-chip-row compact">
                <span className="meta-chip subtle">{agent.roomTitles.length} 个房间</span>
                {agent.resolvedModel ? <span className="meta-chip subtle">{agent.resolvedModel}</span> : null}
              </div>
              {agent.recentToolName && agent.status === "working" ? <p className="agent-world-card-note">正在处理: {agent.recentToolName}</p> : null}
              {agent.recentMessage && agent.status === "resting" ? <p className="agent-world-card-note">最近聊天: {agent.recentMessage}</p> : null}
              <p className="composer-note">
                {agent.roomTitles.length > 0 ? `房间: ${agent.roomTitles.join("、")}` : "还没有加入任何活跃房间"}
              </p>
              {agent.lastActiveAt ? <p className="composer-note">最后活动: {formatTimestamp(agent.lastActiveAt)}</p> : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
