import { useCallback, useEffect } from "react";
import type { AgentSharedState, RoomAgentId, RoomSession, RoomWorkspaceState } from "@/lib/chat/types";
import { saveWorkspaceEnvelope } from "@/components/workspace/persistence";
import { buildWorkspaceStateSnapshot, canApplyConflictWorkspaceSnapshot, workspaceStatesEqual } from "@/components/workspace/workspace-state";

type MutableRef<T> = {
  current: T;
};

export function useWorkspacePersistence(args: {
  hydrated: boolean;
  rooms: RoomSession[];
  agentStates: Record<RoomAgentId, AgentSharedState>;
  activeRoomId: string;
  selectedConsoleAgentId: RoomAgentId | null;
  roomsRef: MutableRef<RoomSession[]>;
  agentStatesRef: MutableRef<Record<RoomAgentId, AgentSharedState>>;
  activeRoomIdRef: MutableRef<string>;
  selectedConsoleAgentIdRef: MutableRef<RoomAgentId | null>;
  workspaceVersionRef: MutableRef<number>;
  skipNextServerPersistRef: MutableRef<boolean>;
  workspacePersistTimerRef: MutableRef<number | null>;
  pendingWorkspacePersistRef: MutableRef<RoomWorkspaceState | null>;
  workspacePersistInFlightRef: MutableRef<boolean>;
  workspacePersistNonceRef: MutableRef<number>;
  applyWorkspaceSnapshot: (
    snapshot: RoomWorkspaceState,
    version: number,
    options?: {
      skipServerPersist?: boolean;
    },
  ) => void;
  setWorkspaceVersion: (version: number) => void;
}) {
  const persistWorkspaceSnapshot = useCallback(async () => {
    if (args.workspacePersistInFlightRef.current) {
      return;
    }

    args.workspacePersistInFlightRef.current = true;
    let scheduledDelayedRetry = false;
    const getCurrentWorkspaceSnapshot = () =>
      buildWorkspaceStateSnapshot({
        rooms: args.roomsRef.current,
        agentStates: args.agentStatesRef.current,
        activeRoomId: args.activeRoomIdRef.current,
        selectedConsoleAgentId: args.selectedConsoleAgentIdRef.current,
      });

    try {
      while (args.pendingWorkspacePersistRef.current) {
        const payload = args.pendingWorkspacePersistRef.current;
        const requestNonce = args.workspacePersistNonceRef.current;
        args.pendingWorkspacePersistRef.current = null;

        const response = await saveWorkspaceEnvelope({
          expectedVersion: args.workspaceVersionRef.current,
          state: payload,
        });

        if (!response) {
          args.pendingWorkspacePersistRef.current = args.pendingWorkspacePersistRef.current ?? getCurrentWorkspaceSnapshot();
          window.setTimeout(() => {
            void persistWorkspaceSnapshot();
          }, 1000);
          scheduledDelayedRetry = true;
          break;
        }

        if (response.ok) {
          const nextEnvelope = (await response.json().catch(() => null)) as { version?: number } | null;
          if (typeof nextEnvelope?.version === "number") {
            args.workspaceVersionRef.current = nextEnvelope.version;
            args.setWorkspaceVersion(nextEnvelope.version);
          }
          continue;
        }

        if (response.status !== 409) {
          continue;
        }

        const conflictPayload = (await response.json().catch(() => null)) as {
          envelope?: { version?: number; state?: RoomWorkspaceState };
        } | null;
        const conflictVersion = conflictPayload?.envelope?.version;
        const conflictState = conflictPayload?.envelope?.state;

        if (typeof conflictVersion === "number") {
          args.workspaceVersionRef.current = conflictVersion;
          args.setWorkspaceVersion(conflictVersion);
        }

        const requestIsLatest = requestNonce === args.workspacePersistNonceRef.current && args.pendingWorkspacePersistRef.current === null;
        const latestSnapshot = getCurrentWorkspaceSnapshot();
        const localStateChangedSinceRequest = !workspaceStatesEqual(latestSnapshot, payload);
        const localPersistStillQueued = args.workspacePersistTimerRef.current !== null;

        if (
          requestIsLatest
          && !localStateChangedSinceRequest
          && !localPersistStillQueued
          && typeof conflictVersion === "number"
          && conflictState
          && canApplyConflictWorkspaceSnapshot({
            localState: latestSnapshot,
            conflictState,
          })
        ) {
          args.applyWorkspaceSnapshot(conflictState, conflictVersion, {
            skipServerPersist: true,
          });
          break;
        }

        args.pendingWorkspacePersistRef.current = args.pendingWorkspacePersistRef.current ?? latestSnapshot;
      }
    } finally {
      args.workspacePersistInFlightRef.current = false;
      if (args.pendingWorkspacePersistRef.current && !scheduledDelayedRetry) {
        void persistWorkspaceSnapshot();
      }
    }
  }, [args]);

  useEffect(() => {
    if (!args.hydrated || args.rooms.length === 0 || !args.activeRoomId) {
      return;
    }

    if (args.skipNextServerPersistRef.current) {
      args.skipNextServerPersistRef.current = false;
      return;
    }

    const payload = buildWorkspaceStateSnapshot({
      rooms: args.rooms,
      agentStates: args.agentStates,
      activeRoomId: args.activeRoomId,
      selectedConsoleAgentId: args.selectedConsoleAgentId,
    });

    const timer = window.setTimeout(() => {
      args.workspacePersistNonceRef.current += 1;
      args.pendingWorkspacePersistRef.current = payload;
      void persistWorkspaceSnapshot();
    }, 400);
    args.workspacePersistTimerRef.current = timer;

    return () => {
      window.clearTimeout(timer);
      if (args.workspacePersistTimerRef.current === timer) {
        args.workspacePersistTimerRef.current = null;
      }
    };
  }, [
    args.activeRoomId,
    args.agentStates,
    args.hydrated,
    args.pendingWorkspacePersistRef,
    persistWorkspaceSnapshot,
    args.rooms,
    args.selectedConsoleAgentId,
    args.skipNextServerPersistRef,
    args.workspacePersistNonceRef,
    args.workspacePersistTimerRef,
  ]);
}
