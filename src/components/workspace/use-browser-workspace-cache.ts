import { useEffect } from "react";
import type { AgentSharedState, RoomAgentId, RoomSession } from "@/lib/chat/types";
import { saveWorkspaceBootstrapToLocalStorage, saveWorkspaceStateToIndexedDb } from "@/components/workspace/persistence";
import { buildWorkspaceStateSnapshot } from "@/components/workspace/workspace-state";

export function useBrowserWorkspaceCache(args: {
  hydrated: boolean;
  rooms: RoomSession[];
  agentStates: Record<RoomAgentId, AgentSharedState>;
  activeRoomId: string;
  selectedConsoleAgentId: RoomAgentId | null;
}) {
  const { hydrated, rooms, agentStates, activeRoomId, selectedConsoleAgentId } = args;

  useEffect(() => {
    if (!hydrated || rooms.length === 0 || !activeRoomId) {
      return;
    }

    const snapshot = buildWorkspaceStateSnapshot({
      rooms,
      agentStates,
      activeRoomId,
      selectedConsoleAgentId,
    });

    saveWorkspaceBootstrapToLocalStorage(snapshot);
    const timer = window.setTimeout(() => {
      void saveWorkspaceStateToIndexedDb(snapshot);
    }, 200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeRoomId, agentStates, hydrated, rooms, selectedConsoleAgentId]);
}
