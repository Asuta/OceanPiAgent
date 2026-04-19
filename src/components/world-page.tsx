"use client";

import { useCallback, useMemo, useState } from "react";
import { WorldDirectChatPanel } from "@/components/room/world-direct-chat-panel";
import { AgentWorldPanel } from "@/components/room/agent-world-panel";
import { useWorkspaceActions, useWorkspaceAgentsState, useWorkspaceRoomsState } from "@/components/workspace-provider";
import type { RoomAgentId } from "@/lib/chat/types";

export function WorldPage() {
  const { rooms, hydrated } = useWorkspaceRoomsState();
  const { agents, agentStates, workspaceRuntimeState } = useWorkspaceAgentsState();
  const { ensureWorldDirectRoom } = useWorkspaceActions();
  const [selectedWorldAgentId, setSelectedWorldAgentId] = useState<RoomAgentId | null>(null);
  const [selectedWorldRoomId, setSelectedWorldRoomId] = useState<string | null>(null);
  const [openingAgentId, setOpeningAgentId] = useState<RoomAgentId | null>(null);
  const [openError, setOpenError] = useState("");

  const selectedAgent = useMemo(
    () => (selectedWorldAgentId ? agents.find((agent) => agent.id === selectedWorldAgentId) ?? null : null),
    [agents, selectedWorldAgentId],
  );

  const openWorldDirectRoom = useCallback(
    async (agentId: RoomAgentId) => {
      setOpenError("");
      setOpeningAgentId(agentId);
      try {
        const room = await ensureWorldDirectRoom(agentId);
        if (!room) {
          throw new Error("未能打开这个 Agent 的单聊房间。");
        }
        setSelectedWorldAgentId(agentId);
        setSelectedWorldRoomId(room.id);
      } catch (error) {
        setOpenError(error instanceof Error ? error.message : "打开单聊房间失败。");
      } finally {
        setOpeningAgentId((current) => (current === agentId ? null : current));
      }
    },
    [ensureWorldDirectRoom],
  );

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
          <div className={`world-page-workspace${selectedWorldRoomId || openingAgentId || openError ? " has-chat-panel" : ""}`}>
            <div className="world-page-scene">
              <AgentWorldPanel
                agents={agents}
                rooms={rooms}
                agentStates={agentStates}
                runtimeState={workspaceRuntimeState}
                selectedAgentId={selectedWorldAgentId}
                onAgentSelect={openWorldDirectRoom}
              />
            </div>

            {selectedAgent && selectedWorldRoomId ? (
              <WorldDirectChatPanel
                roomId={selectedWorldRoomId}
                agentId={selectedAgent.id}
                onClose={() => {
                  setSelectedWorldAgentId(null);
                  setSelectedWorldRoomId(null);
                  setOpenError("");
                }}
              />
            ) : openingAgentId || openError ? (
              <aside className="surface-panel world-chat-panel world-chat-placeholder-panel">
                <div className="world-chat-placeholder">
                  <p className="section-label">Direct Chat</p>
                  <h3>{openingAgentId ? "正在打开单聊..." : "点击任意小人开始对话"}</h3>
                  <p>{openError || "右侧会弹出一个简化版单聊窗口，只保留消息、工具调用和草稿流。"}</p>
                </div>
              </aside>
            ) : null}
          </div>
        </section>
      ) : (
        <section className="surface-panel empty-panel large">正在恢复像素办公室...</section>
      )}
    </div>
  );
}
