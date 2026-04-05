import { useEffect } from "react";
import type { RoomAgentDefinition, RoomWorkspaceState } from "@/lib/chat/types";
import { ROOM_AGENTS } from "@/lib/chat/catalog";
import { createInitialAgentStates, createRoomSession } from "@/lib/chat/workspace-domain";
import {
  fetchWorkspaceEnvelope,
  loadBrowserWorkspaceState,
  loadWorkspaceBootstrapFromLocalStorage,
} from "@/components/workspace/persistence";
import { applyWorkspaceBootstrapToSnapshot, mergeBrowserWorkspaceIntoSnapshot } from "@/components/workspace/browser-workspace-cache";

type MutableRef<T> = {
  current: T;
};

export function useWorkspaceHydration(args: {
  agentsRef: MutableRef<RoomAgentDefinition[]>;
  applyWorkspaceSnapshot: (
    snapshot: RoomWorkspaceState,
    version: number,
    options?: {
      skipServerPersist?: boolean;
    },
  ) => void;
  fetchAgentDefinitions: () => Promise<RoomAgentDefinition[]>;
  parseWorkspaceState: (raw: string) => RoomWorkspaceState | null;
  migrateLegacyWorkspaceState: (raw: string) => RoomWorkspaceState | null;
  onAgentsLoaded: (agents: RoomAgentDefinition[]) => void;
}) {
  const {
    agentsRef,
    applyWorkspaceSnapshot,
    fetchAgentDefinitions,
    parseWorkspaceState,
    migrateLegacyWorkspaceState,
    onAgentsLoaded,
  } = args;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const bootstrap = loadWorkspaceBootstrapFromLocalStorage();
      const [serverEnvelope, loadedAgents, browserWorkspace] = await Promise.all([
        fetchWorkspaceEnvelope(),
        fetchAgentDefinitions().catch(() => ROOM_AGENTS),
        loadBrowserWorkspaceState({
          parseWorkspaceState,
          migrateLegacyWorkspaceState,
        }),
      ]);

      const resolvedAgents = loadedAgents.length > 0 ? loadedAgents : ROOM_AGENTS;
      agentsRef.current = resolvedAgents;
      if (!cancelled) {
        onAgentsLoaded(resolvedAgents);
      }

      const serverVersion = typeof serverEnvelope?.version === "number" ? serverEnvelope.version : 0;
      const recoveredServerState = serverEnvelope?.state
        ? mergeBrowserWorkspaceIntoSnapshot(serverEnvelope.state, browserWorkspace)
        : null;
      const serverState = recoveredServerState ? applyWorkspaceBootstrapToSnapshot(recoveredServerState, bootstrap) : null;
      const cachedBrowserState = browserWorkspace ? applyWorkspaceBootstrapToSnapshot(browserWorkspace, bootstrap) : null;

      if (cancelled) {
        return;
      }

      if (serverState && serverVersion > 0) {
        applyWorkspaceSnapshot(serverState, serverVersion, { skipServerPersist: true });
        return;
      }

      if (cachedBrowserState) {
        applyWorkspaceSnapshot(cachedBrowserState, serverVersion, { skipServerPersist: true });
        return;
      }

      if (serverState) {
        applyWorkspaceSnapshot(serverState, serverVersion, { skipServerPersist: true });
        return;
      }

      const initialRoom = createRoomSession(1, "concierge", resolvedAgents);
      applyWorkspaceSnapshot(
        {
          rooms: [initialRoom],
          agentStates: createInitialAgentStates(resolvedAgents),
          activeRoomId: initialRoom.id,
          selectedConsoleAgentId: initialRoom.agentId,
        },
        0,
        { skipServerPersist: false },
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [agentsRef, applyWorkspaceSnapshot, fetchAgentDefinitions, migrateLegacyWorkspaceState, onAgentsLoaded, parseWorkspaceState]);
}
