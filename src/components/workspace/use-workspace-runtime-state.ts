import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { AgentSharedState, RoomAgentDefinition, RoomAgentId, RoomSession, RoomWorkspaceState } from "@/lib/chat/types";
import { createRoomSession, dedupeRoomMessages, getPrimaryRoomAgentId } from "@/lib/chat/workspace-domain";
import { applyWorkspaceStatePatch, type WorkspaceStreamEvent } from "@/lib/chat/workspace-stream";
import { fetchWorkspaceEnvelope, postRoomCommand } from "@/components/workspace/persistence";
import { recordWorkspaceUiTiming } from "@/components/workspace/workspace-ui-timing";
import type { AgentCompactionFeedback } from "@/components/workspace/use-workspace-agent-context-actions";

type MutableRef<T> = {
  current: T;
};

export function useWorkspaceRuntimeState(args: {
  defaultAgentId: RoomAgentId;
  agentsRef: MutableRef<RoomAgentDefinition[]>;
  roomsRef: MutableRef<RoomSession[]>;
  agentStatesRef: MutableRef<Record<RoomAgentId, AgentSharedState>>;
  workspaceVersionRef: MutableRef<number>;
  activeRoomIdRef: MutableRef<string>;
  selectedConsoleAgentIdRef: MutableRef<RoomAgentId | null>;
  skipNextServerPersistRef: MutableRef<boolean>;
  setAgents: Dispatch<SetStateAction<RoomAgentDefinition[]>>;
  setRooms: Dispatch<SetStateAction<RoomSession[]>>;
  setAgentStates: Dispatch<SetStateAction<Record<RoomAgentId, AgentSharedState>>>;
  setAgentCompactionFeedback: Dispatch<SetStateAction<Record<RoomAgentId, AgentCompactionFeedback | null>>>;
  setActiveRoomId: Dispatch<SetStateAction<string>>;
  setSelectedConsoleAgentId: Dispatch<SetStateAction<RoomAgentId | null>>;
  setWorkspaceVersion: Dispatch<SetStateAction<number>>;
  setHydrated: Dispatch<SetStateAction<boolean>>;
  setPendingRoomCommandIds: Dispatch<SetStateAction<Record<string, boolean>>>;
  ensureAgentStateMap: (
    current: Record<RoomAgentId, AgentSharedState>,
    agentDefinitions: RoomAgentDefinition[],
    rooms: RoomSession[],
  ) => Record<RoomAgentId, AgentSharedState>;
  ensureAgentFeedbackMap: (
    current: Record<RoomAgentId, AgentCompactionFeedback | null>,
    agentDefinitions: RoomAgentDefinition[],
    agentStates: Record<RoomAgentId, AgentSharedState>,
  ) => Record<RoomAgentId, AgentCompactionFeedback | null>;
}) {
  const {
    defaultAgentId,
    agentsRef,
    roomsRef,
    agentStatesRef,
    workspaceVersionRef,
    activeRoomIdRef,
    selectedConsoleAgentIdRef,
    skipNextServerPersistRef,
    setAgents,
    setRooms,
    setAgentStates,
    setAgentCompactionFeedback,
    setActiveRoomId,
    setSelectedConsoleAgentId,
    setWorkspaceVersion,
    setHydrated,
    setPendingRoomCommandIds,
    ensureAgentStateMap,
    ensureAgentFeedbackMap,
  } = args;

  const applyWorkspaceSnapshot = useCallback(
    (
      snapshot: RoomWorkspaceState,
      version: number,
      options?: {
        skipServerPersist?: boolean;
      },
    ) => {
      const applyStartedAt = typeof window === "undefined" ? 0 : performance.now();
      if (options?.skipServerPersist) {
        skipNextServerPersistRef.current = true;
      }
      const nextRooms = (snapshot.rooms.length > 0 ? snapshot.rooms : [createRoomSession(1, defaultAgentId, agentsRef.current)]).map((room) => ({
        ...room,
        roomMessages: dedupeRoomMessages(room.roomMessages),
      }));
      const nextAgentStates = ensureAgentStateMap(snapshot.agentStates, agentsRef.current, nextRooms);
      const nextActiveRoomId =
        snapshot.activeRoomId && nextRooms.some((room) => room.id === snapshot.activeRoomId)
          ? snapshot.activeRoomId
          : nextRooms[0]?.id ?? "";
      const nextSelectedConsoleAgentId = snapshot.selectedConsoleAgentId ?? getPrimaryRoomAgentId(nextRooms[0]);

      roomsRef.current = nextRooms;
      agentStatesRef.current = nextAgentStates;
      activeRoomIdRef.current = nextActiveRoomId;
      selectedConsoleAgentIdRef.current = nextSelectedConsoleAgentId;
      workspaceVersionRef.current = version;
      setRooms(nextRooms);
      setAgentStates(nextAgentStates);
      setAgentCompactionFeedback((current) => ensureAgentFeedbackMap(current, agentsRef.current, nextAgentStates));
      setActiveRoomId(nextActiveRoomId);
      setSelectedConsoleAgentId(nextSelectedConsoleAgentId);
      setWorkspaceVersion(version);
      setHydrated(true);
      if (typeof window !== "undefined") {
        recordWorkspaceUiTiming({
          phase: "workspace_snapshot_applied",
          elapsedMs: Math.round((performance.now() - applyStartedAt) * 10) / 10,
          details: {
            version,
            roomCount: nextRooms.length,
            activeRoomId: nextActiveRoomId,
          },
        });
      }
    },
    [
      activeRoomIdRef,
      agentStatesRef,
      agentsRef,
      defaultAgentId,
      ensureAgentFeedbackMap,
      ensureAgentStateMap,
      roomsRef,
      selectedConsoleAgentIdRef,
      setActiveRoomId,
      setAgentCompactionFeedback,
      setAgentStates,
      setHydrated,
      setRooms,
      setSelectedConsoleAgentId,
      setWorkspaceVersion,
      skipNextServerPersistRef,
      workspaceVersionRef,
    ],
  );

  const applyWorkspaceEnvelope = useCallback(
    (envelope: { version?: number; state?: RoomWorkspaceState } | null | undefined) => {
      if (!envelope?.state || typeof envelope.version !== "number") {
        throw new Error("Room command did not return a valid workspace snapshot.");
      }

      applyWorkspaceSnapshot(envelope.state, envelope.version, { skipServerPersist: true });
      return envelope.state;
    },
    [applyWorkspaceSnapshot],
  );

  const applyWorkspaceStreamEvent = useCallback(
    (event: WorkspaceStreamEvent) => {
      if (event.type === "snapshot") {
        applyWorkspaceSnapshot(event.state, event.version, { skipServerPersist: true });
        return;
      }

      const baseState: RoomWorkspaceState = {
        rooms: roomsRef.current,
        agentStates: agentStatesRef.current,
        activeRoomId: activeRoomIdRef.current,
        ...(selectedConsoleAgentIdRef.current
          ? {
              selectedConsoleAgentId: selectedConsoleAgentIdRef.current,
            }
          : {}),
      };
      const nextState = applyWorkspaceStatePatch(baseState, event.patch);
      applyWorkspaceSnapshot(nextState, event.version, { skipServerPersist: true });
    },
    [activeRoomIdRef, agentStatesRef, applyWorkspaceSnapshot, roomsRef, selectedConsoleAgentIdRef],
  );

  const runRoomCommandRequest = useCallback(
    async (
      payload: Record<string, unknown>,
      options?: {
        pendingRoomId?: string;
      },
    ) => {
      if (options?.pendingRoomId) {
        setPendingRoomCommandIds((current) => ({
          ...current,
          [options.pendingRoomId as string]: true,
        }));
      }

      try {
        const response = await postRoomCommand(payload);
        if (!response?.ok) {
          throw new Error(response?.error ?? "Room command failed.");
        }

        return applyWorkspaceEnvelope(response.envelope);
      } finally {
        if (options?.pendingRoomId) {
          setPendingRoomCommandIds((current) => {
            const nextState = { ...current };
            delete nextState[options.pendingRoomId as string];
            return nextState;
          });
        }
      }
    },
    [applyWorkspaceEnvelope, setPendingRoomCommandIds],
  );

  const refreshWorkspaceFromServer = useCallback(async () => {
    const fetchStartedAt = typeof window === "undefined" ? 0 : performance.now();
    const payload = await fetchWorkspaceEnvelope();
    if (typeof window !== "undefined") {
      recordWorkspaceUiTiming({
        phase: "workspace_fetch_done",
        elapsedMs: Math.round((performance.now() - fetchStartedAt) * 10) / 10,
        details: {
          ok: Boolean(payload?.state),
          version: typeof payload?.version === "number" ? payload.version : null,
        },
      });
    }
    if (typeof payload?.version !== "number" || !payload.state) {
      return null;
    }

    if (payload.version >= workspaceVersionRef.current) {
      applyWorkspaceSnapshot(payload.state, payload.version, { skipServerPersist: true });
    }

    return payload;
  }, [applyWorkspaceSnapshot, workspaceVersionRef]);

  const handleAgentsLoaded = useCallback((nextAgents: RoomAgentDefinition[]) => {
    setAgents(nextAgents);
    setAgentStates((current) => ensureAgentStateMap(current, nextAgents, roomsRef.current));
    setAgentCompactionFeedback((current) => ensureAgentFeedbackMap(current, nextAgents, agentStatesRef.current));
  }, [agentStatesRef, ensureAgentFeedbackMap, ensureAgentStateMap, roomsRef, setAgentCompactionFeedback, setAgentStates, setAgents]);

  return {
    applyWorkspaceSnapshot,
    applyWorkspaceEnvelope,
    applyWorkspaceStreamEvent,
    runRoomCommandRequest,
    refreshWorkspaceFromServer,
    handleAgentsLoaded,
  };
}
