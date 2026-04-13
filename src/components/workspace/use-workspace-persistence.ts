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
  const {
    hydrated,
    rooms,
    agentStates,
    activeRoomId,
    selectedConsoleAgentId,
    roomsRef,
    agentStatesRef,
    activeRoomIdRef,
    selectedConsoleAgentIdRef,
    workspaceVersionRef,
    skipNextServerPersistRef,
    workspacePersistTimerRef,
    pendingWorkspacePersistRef,
    workspacePersistInFlightRef,
    workspacePersistNonceRef,
    applyWorkspaceSnapshot,
    setWorkspaceVersion,
  } = args;

  const persistWorkspaceSnapshot = useCallback(async () => {
    if (workspacePersistInFlightRef.current) {
      return;
    }

    workspacePersistInFlightRef.current = true;
    let scheduledDelayedRetry = false;
    const getCurrentWorkspaceSnapshot = () =>
      buildWorkspaceStateSnapshot({
        rooms: roomsRef.current,
        agentStates: agentStatesRef.current,
        activeRoomId: activeRoomIdRef.current,
        selectedConsoleAgentId: selectedConsoleAgentIdRef.current,
      });

    try {
      while (pendingWorkspacePersistRef.current) {
        const payload = pendingWorkspacePersistRef.current;
        const requestNonce = workspacePersistNonceRef.current;
        pendingWorkspacePersistRef.current = null;

        const response = await saveWorkspaceEnvelope({
          expectedVersion: workspaceVersionRef.current,
          state: payload,
        });

        if (!response) {
          pendingWorkspacePersistRef.current = pendingWorkspacePersistRef.current ?? getCurrentWorkspaceSnapshot();
          window.setTimeout(() => {
            void persistWorkspaceSnapshot();
          }, 1000);
          scheduledDelayedRetry = true;
          break;
        }

        if (response.ok) {
          const nextEnvelope = (await response.json().catch(() => null)) as { version?: number } | null;
          if (typeof nextEnvelope?.version === "number") {
            workspaceVersionRef.current = nextEnvelope.version;
            setWorkspaceVersion(nextEnvelope.version);
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
          workspaceVersionRef.current = conflictVersion;
          setWorkspaceVersion(conflictVersion);
        }

        const requestIsLatest = requestNonce === workspacePersistNonceRef.current && pendingWorkspacePersistRef.current === null;
        const latestSnapshot = getCurrentWorkspaceSnapshot();
        const localStateChangedSinceRequest = !workspaceStatesEqual(latestSnapshot, payload);
        const localPersistStillQueued = workspacePersistTimerRef.current !== null;

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
          applyWorkspaceSnapshot(conflictState, conflictVersion, {
            skipServerPersist: true,
          });
          break;
        }

        pendingWorkspacePersistRef.current = pendingWorkspacePersistRef.current ?? latestSnapshot;
      }
    } finally {
      workspacePersistInFlightRef.current = false;
      if (pendingWorkspacePersistRef.current && !scheduledDelayedRetry) {
        void persistWorkspaceSnapshot();
      }
    }
  }, [
    activeRoomIdRef,
    agentStatesRef,
    applyWorkspaceSnapshot,
    pendingWorkspacePersistRef,
    roomsRef,
    selectedConsoleAgentIdRef,
    setWorkspaceVersion,
    workspacePersistInFlightRef,
    workspacePersistNonceRef,
    workspacePersistTimerRef,
    workspaceVersionRef,
  ]);

  useEffect(() => {
    if (!hydrated || rooms.length === 0 || !activeRoomId) {
      return;
    }

    if (skipNextServerPersistRef.current) {
      skipNextServerPersistRef.current = false;
      return;
    }

    const payload = buildWorkspaceStateSnapshot({
      rooms,
      agentStates,
      activeRoomId,
      selectedConsoleAgentId,
    });

    const timer = window.setTimeout(() => {
      workspacePersistNonceRef.current += 1;
      pendingWorkspacePersistRef.current = payload;
      void persistWorkspaceSnapshot();
    }, 400);
    workspacePersistTimerRef.current = timer;

    return () => {
      window.clearTimeout(timer);
      if (workspacePersistTimerRef.current === timer) {
        workspacePersistTimerRef.current = null;
      }
    };
  }, [
    activeRoomId,
    agentStates,
    hydrated,
    pendingWorkspacePersistRef,
    persistWorkspaceSnapshot,
    rooms,
    selectedConsoleAgentId,
    skipNextServerPersistRef,
    workspacePersistNonceRef,
    workspacePersistTimerRef,
  ]);
}
