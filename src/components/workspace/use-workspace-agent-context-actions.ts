import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { AgentSharedState, ChatSettings, MemoryBackendId, RoomAgentDefinition, RoomAgentId, RoomSession } from "@/lib/chat/types";
import {
  coerceCompactionFreshTailCount,
  coerceCompactionTokenThreshold,
  coerceSkillIds,
  coerceThinkingLevel,
  coerceMaxToolLoopSteps,
} from "@/lib/chat/types";
import { createInitialAgentStates, createRoomSession, createTimestamp } from "@/lib/chat/workspace-domain";
import { clearPersistedWorkspaceState } from "@/components/workspace/persistence";

type MutableRef<T> = {
  current: T;
};

export interface AgentCompactionFeedback {
  status: "success" | "noop" | "error";
  message: string;
  summary: string;
  updatedAt: string;
}

export function createInitialAgentCompactionFeedback(agentDefinitions: RoomAgentDefinition[]): Record<RoomAgentId, AgentCompactionFeedback | null> {
  return Object.fromEntries(agentDefinitions.map((agent) => [agent.id, null])) as Record<RoomAgentId, AgentCompactionFeedback | null>;
}

export function useWorkspaceAgentContextActions(args: {
  defaultAgentId: RoomAgentId;
  agentsRef: MutableRef<RoomAgentDefinition[]>;
  roomsRef: MutableRef<RoomSession[]>;
  agentStatesRef: MutableRef<Record<RoomAgentId, AgentSharedState>>;
  runningAgentRequestIds: Record<string, string>;
  updateAgentState: (agentId: RoomAgentId, updater: (state: AgentSharedState) => AgentSharedState) => void;
  setRooms: Dispatch<SetStateAction<RoomSession[]>>;
  setAgentStates: Dispatch<SetStateAction<Record<RoomAgentId, AgentSharedState>>>;
  setAgentCompactionFeedback: Dispatch<SetStateAction<Record<RoomAgentId, AgentCompactionFeedback | null>>>;
  setActiveRoomId: Dispatch<SetStateAction<string>>;
  setSelectedConsoleAgentId: Dispatch<SetStateAction<RoomAgentId | null>>;
  setSelectedSenderByRoomId: Dispatch<SetStateAction<Record<string, string>>>;
  setDraftsByRoomId: Dispatch<SetStateAction<Record<string, string>>>;
}): {
  compactingAgentContextIds: Record<string, boolean>;
  clearAllWorkspace: () => Promise<void>;
  clearAgentConsole: (agentId: RoomAgentId) => void;
  resetAgentContext: (agentId: RoomAgentId) => Promise<void>;
  compactAgentContext: (agentId: RoomAgentId) => Promise<void>;
  updateAgentSettings: (agentId: RoomAgentId, patch: Partial<ChatSettings>) => void;
} {
  const [resettingAgentContextIds, setResettingAgentContextIds] = useState<Record<string, boolean>>({});
  const [compactingAgentContextIds, setCompactingAgentContextIds] = useState<Record<string, boolean>>({});

  const clearAllWorkspace = useCallback(async () => {
    const initialRoom = createRoomSession(1, args.defaultAgentId, args.agentsRef.current);
    const initialAgentStates = createInitialAgentStates(args.agentsRef.current);

    args.roomsRef.current = [initialRoom];
    args.agentStatesRef.current = initialAgentStates;

    args.setRooms([initialRoom]);
    args.setAgentStates(initialAgentStates);
    args.setAgentCompactionFeedback(createInitialAgentCompactionFeedback(args.agentsRef.current));
    args.setActiveRoomId(initialRoom.id);
    args.setSelectedConsoleAgentId(initialRoom.agentId);
    args.setSelectedSenderByRoomId({});
    args.setDraftsByRoomId({});
    setResettingAgentContextIds({});
    setCompactingAgentContextIds({});

    await clearPersistedWorkspaceState();

    await Promise.allSettled(
      args.agentsRef.current.map((agent) =>
        fetch("/api/agent-memory/reset", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ agentId: agent.id }),
        }),
      ),
    );
  }, [args]);

  const clearAgentConsole = useCallback(
    (agentId: RoomAgentId) => {
      if (args.runningAgentRequestIds[agentId]) {
        return;
      }

      args.updateAgentState(agentId, (state) => ({
        ...state,
        agentTurns: [],
        updatedAt: createTimestamp(),
      }));
    },
    [args],
  );

  const resetAgentContext = useCallback(
    async (agentId: RoomAgentId) => {
      if (args.runningAgentRequestIds[agentId] || resettingAgentContextIds[agentId]) {
        return;
      }

      setResettingAgentContextIds((current) => ({
        ...current,
        [agentId]: true,
      }));

      try {
        const response = await fetch("/api/agent-memory/reset", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ agentId }),
        });

        if (!response.ok) {
          throw new Error("Failed to reset agent context.");
        }

        args.updateAgentState(agentId, (state) => ({
          ...state,
          agentTurns: [],
          updatedAt: createTimestamp(),
        }));
      } finally {
        setResettingAgentContextIds((current) => {
          const next = { ...current };
          delete next[agentId];
          return next;
        });
      }
    },
    [args, resettingAgentContextIds],
  );

  const compactAgentContext = useCallback(
    async (agentId: RoomAgentId) => {
      if (args.runningAgentRequestIds[agentId] || compactingAgentContextIds[agentId]) {
        return;
      }

      setCompactingAgentContextIds((current) => ({
        ...current,
        [agentId]: true,
      }));

      try {
        const response = await fetch("/api/agent-memory/compact", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ agentId }),
        });

        const payload = (await response.json().catch(() => null)) as
          | {
              compacted?: boolean;
              record?: {
                summary?: string;
                prunedMessages?: number;
                charsBefore?: number;
                charsAfter?: number;
              } | null;
              error?: string;
            }
          | null;

        if (!response.ok) {
          throw new Error(payload?.error || "Failed to compact agent context.");
        }

        const summary = payload?.record?.summary?.trim() || "";
        const feedback: AgentCompactionFeedback = payload?.compacted
          ? {
              status: "success",
              message:
                typeof payload.record?.prunedMessages === "number"
                  ? `已压缩 ${payload.record.prunedMessages} 条隐藏历史消息。`
                  : "已压缩隐藏上下文。",
              summary,
              updatedAt: createTimestamp(),
            }
          : {
              status: "noop",
              message: "当前没有足够的隐藏上下文可压缩。",
              summary,
              updatedAt: createTimestamp(),
            };

        args.setAgentCompactionFeedback((current) => ({
          ...current,
          [agentId]: feedback,
        }));

        args.updateAgentState(agentId, (state) => ({
          ...state,
          updatedAt: createTimestamp(),
        }));
      } catch (error) {
        args.setAgentCompactionFeedback((current) => ({
          ...current,
          [agentId]: {
            status: "error",
            message: error instanceof Error ? error.message : "压缩隐藏上下文时发生未知错误。",
            summary: "",
            updatedAt: createTimestamp(),
          },
        }));
      } finally {
        setCompactingAgentContextIds((current) => {
          const next = { ...current };
          delete next[agentId];
          return next;
        });
      }
    },
    [args, compactingAgentContextIds],
  );

  const updateAgentSettings = useCallback(
    (agentId: RoomAgentId, patch: Partial<ChatSettings>) => {
      args.updateAgentState(agentId, (state) => ({
        ...state,
        settings: {
          ...state.settings,
          ...patch,
          memoryBackend: "sqlite-fts" as MemoryBackendId,
          compactionTokenThreshold: coerceCompactionTokenThreshold(patch.compactionTokenThreshold ?? state.settings.compactionTokenThreshold),
          compactionFreshTailCount: coerceCompactionFreshTailCount(patch.compactionFreshTailCount ?? state.settings.compactionFreshTailCount),
          maxToolLoopSteps: coerceMaxToolLoopSteps(patch.maxToolLoopSteps ?? state.settings.maxToolLoopSteps),
          thinkingLevel: coerceThinkingLevel(patch.thinkingLevel ?? state.settings.thinkingLevel),
          enabledSkillIds: coerceSkillIds(patch.enabledSkillIds ?? state.settings.enabledSkillIds),
        },
        updatedAt: createTimestamp(),
      }));
    },
    [args],
  );

  return {
    compactingAgentContextIds,
    clearAllWorkspace,
    clearAgentConsole,
    resetAgentContext,
    compactAgentContext,
    updateAgentSettings,
  };
}
