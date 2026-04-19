"use client";

import { AgentWorldPanel } from "@/components/room/agent-world-panel";
import { useWorkspaceAgentsState, useWorkspaceRoomsState } from "@/components/workspace-provider";

export function WorldPage() {
  const { rooms, hydrated } = useWorkspaceRoomsState();
  const { agents, agentStates } = useWorkspaceAgentsState();

  return (
    <div className="page-stack world-page">
      <section className="hero-panel surface-panel page-enter">
        <div className="hero-copy">
          <p className="eyebrow-label">Pixel Office</p>
          <h1>把整个工作区变成一个轻松一点的小办公室</h1>
          <p>
            这里不再强调程序里的细碎状态，只保留两种生活节奏：休息和工作。只有在真的跑工具时，小人才会走到自己的电脑前开工。
          </p>
        </div>
      </section>

      {hydrated ? (
        <section className="surface-panel section-panel page-enter page-enter-delay-1">
          <AgentWorldPanel agents={agents} rooms={rooms} agentStates={agentStates} />
        </section>
      ) : (
        <section className="surface-panel empty-panel large">正在恢复像素办公室...</section>
      )}
    </div>
  );
}
