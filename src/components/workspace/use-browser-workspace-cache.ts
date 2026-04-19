import { useEffect } from "react";
import type { AgentSharedState, RoomAgentId, RoomSession } from "@/lib/chat/types";
import { saveWorkspaceBootstrapToLocalStorage, saveWorkspaceStateToIndexedDb } from "@/components/workspace/persistence";
import { buildWorkspaceStateSnapshot } from "@/components/workspace/workspace-state";

const BROWSER_CACHE_WRITE_DEBOUNCE_MS = 80;

export function useBrowserWorkspaceCache(args: {
  hydrated: boolean;
  rooms: RoomSession[];
  agentStates: Record<RoomAgentId, AgentSharedState>;
  activeRoomId: string;
  selectedConsoleAgentId: RoomAgentId | null;
}) {
  useEffect(() => {
    if (!args.hydrated || args.rooms.length === 0 || !args.activeRoomId) {
      return;
    }

    const snapshot = buildWorkspaceStateSnapshot({
      rooms: args.rooms,
      agentStates: args.agentStates,
      activeRoomId: args.activeRoomId,
      selectedConsoleAgentId: args.selectedConsoleAgentId,
    });

    saveWorkspaceBootstrapToLocalStorage(snapshot);
    const timer = window.setTimeout(() => {
      void saveWorkspaceStateToIndexedDb(snapshot);
    }, BROWSER_CACHE_WRITE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [args]);
}
