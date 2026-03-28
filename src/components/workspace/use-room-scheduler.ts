import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { RoomAgentId, RoomMessage, RoomSession } from "@/lib/chat/types";
import { createTimestamp, getEnabledAgentParticipants, getPrimaryRoomAgentId } from "@/lib/chat/workspace-domain";
import {
  createSchedulerPacket,
  getNextAgentParticipant,
  getSchedulerVisibleTargetMessages,
  roomHasRunningAgent,
  shouldAutoRestartSchedulerForMessage,
  type ActiveSchedulerRun,
} from "@/components/workspace/scheduler";
import type { ActiveRoomRun, ExecuteAgentTurnResult } from "@/components/workspace/use-room-execution";
import { createUuid } from "@/lib/utils/uuid";

export function useRoomScheduler(args: {
  roomsRef: MutableRefObject<RoomSession[]>;
  activeRunsRef: MutableRefObject<Record<string, ActiveRoomRun>>;
  activeSchedulerRunsRef: MutableRefObject<Record<string, ActiveSchedulerRun>>;
  updateRoomState: (roomId: string, updater: (room: RoomSession) => RoomSession) => void;
  executeAgentTurn: (args: {
    roomId: string;
    agentId: RoomAgentId;
    inputMessage: RoomMessage;
    anchorMessageId?: string;
    runRequestId?: string;
  }) => Promise<ExecuteAgentTurnResult>;
  defaultAgentId: RoomAgentId;
  maxRounds: number;
}) {
  const {
    roomsRef,
    activeRunsRef,
    activeSchedulerRunsRef,
    updateRoomState,
    executeAgentTurn,
    defaultAgentId,
    maxRounds,
  } = args;
  const schedulerRunsRef = activeSchedulerRunsRef;
  const runRoomSchedulerRef = useRef<(roomId: string) => Promise<void>>(async () => undefined);

  const interruptRoomScheduler = useCallback(
    (roomId: string) => {
      const activeSchedulerRun = schedulerRunsRef.current[roomId];
      if (activeSchedulerRun?.activeAgentId && activeSchedulerRun.activeRequestId) {
        const activeRun = activeRunsRef.current[activeSchedulerRun.activeAgentId];
        if (activeRun && activeRun.requestId === activeSchedulerRun.activeRequestId) {
          activeRun.controller.abort(new Error("Superseded by a newer room message."));
        }
      }

      schedulerRunsRef.current[roomId] = {
        cycleId: createUuid(),
        activeAgentId: null,
        activeRequestId: null,
      };

      updateRoomState(roomId, (room) => ({
        ...room,
        scheduler: {
          ...room.scheduler,
          status: "idle",
          activeParticipantId: null,
          roundCount: 0,
        },
        error: "",
        updatedAt: createTimestamp(),
      }));
    },
    [activeRunsRef, schedulerRunsRef, updateRoomState],
  );

  const roomIsRunning = useCallback((room: RoomSession): boolean => {
    return roomHasRunningAgent(room, schedulerRunsRef.current[room.id]);
  }, [schedulerRunsRef]);

  const maybeStartSchedulerForRoomMessage = useCallback(
    (roomId: string, message: RoomMessage) => {
      const room = roomsRef.current.find((candidate) => candidate.id === roomId);
      if (!room || !shouldAutoRestartSchedulerForMessage(room, message, schedulerRunsRef.current[room.id])) {
        return;
      }

      void runRoomSchedulerRef.current(roomId);
    },
    [roomsRef, schedulerRunsRef],
  );

  const runRoomScheduler = useCallback(
    async (roomId: string) => {
      const cycleId = createUuid();
      interruptRoomScheduler(roomId);
      schedulerRunsRef.current[roomId] = {
        cycleId,
        activeAgentId: null,
        activeRequestId: null,
      };

      let idlePassCount = 0;
      let dispatchedRounds = 0;

      while (true) {
        if (schedulerRunsRef.current[roomId]?.cycleId !== cycleId) {
          return;
        }

        const roomSnapshot = roomsRef.current.find((room) => room.id === roomId);
        if (!roomSnapshot) {
          return;
        }

        const nextParticipant = getNextAgentParticipant(roomSnapshot);
        const enabledAgents = getEnabledAgentParticipants(roomSnapshot);
        if (!nextParticipant || enabledAgents.length === 0) {
          updateRoomState(roomId, (room) => ({
            ...room,
            scheduler: {
              ...room.scheduler,
              status: "idle",
              activeParticipantId: null,
              roundCount: 0,
            },
          }));
          return;
        }

        const nextAfterParticipant = getNextAgentParticipant(roomSnapshot, nextParticipant.id);
        const cutoffSeq = roomSnapshot.roomMessages[roomSnapshot.roomMessages.length - 1]?.seq ?? 0;
        const lastCursor = roomSnapshot.scheduler.agentCursorByParticipantId[nextParticipant.id] ?? 0;
        const unseenMessages = roomSnapshot.roomMessages.filter(
          (message) => message.seq > lastCursor && message.seq <= cutoffSeq && message.sender.id !== nextParticipant.id,
        );
        const visibleTargetMessages = getSchedulerVisibleTargetMessages(unseenMessages, nextParticipant);

        updateRoomState(roomId, (room) => ({
          ...room,
          agentId: getPrimaryRoomAgentId(room),
          scheduler: {
            ...room.scheduler,
            status: "running",
            activeParticipantId: visibleTargetMessages.length > 0 ? nextParticipant.id : null,
            nextAgentParticipantId: nextAfterParticipant?.id ?? nextParticipant.id,
            roundCount: dispatchedRounds,
          },
          updatedAt: createTimestamp(),
        }));

        if (visibleTargetMessages.length === 0) {
          updateRoomState(roomId, (room) => ({
            ...room,
            scheduler: {
              ...room.scheduler,
              agentCursorByParticipantId: {
                ...room.scheduler.agentCursorByParticipantId,
                [nextParticipant.id]: cutoffSeq,
              },
              agentReceiptRevisionByParticipantId: {
                ...room.scheduler.agentReceiptRevisionByParticipantId,
                [nextParticipant.id]: room.receiptRevision,
              },
            },
            updatedAt: createTimestamp(),
          }));

          idlePassCount += 1;
          if (idlePassCount >= enabledAgents.length) {
            updateRoomState(roomId, (room) => ({
              ...room,
              scheduler: {
                ...room.scheduler,
                status: "idle",
                activeParticipantId: null,
                roundCount: 0,
              },
              updatedAt: createTimestamp(),
            }));
            return;
          }
          continue;
        }

        idlePassCount = 0;
        dispatchedRounds += 1;
        if (dispatchedRounds > maxRounds) {
          updateRoomState(roomId, (room) => ({
            ...room,
            error: `Room scheduler stopped after ${maxRounds} agent rounds.`,
            scheduler: {
              ...room.scheduler,
              status: "idle",
              activeParticipantId: null,
              roundCount: 0,
            },
            updatedAt: createTimestamp(),
          }));
          return;
        }

        updateRoomState(roomId, (room) => ({
          ...room,
          scheduler: {
            ...room.scheduler,
            roundCount: dispatchedRounds,
          },
        }));

        const requestId = createUuid();
        schedulerRunsRef.current[roomId] = {
          ...(schedulerRunsRef.current[roomId] ?? {
            cycleId,
            activeAgentId: null,
            activeRequestId: null,
          }),
          cycleId,
          activeAgentId: nextParticipant.agentId ?? null,
          activeRequestId: requestId,
        };

        const schedulerPacket = createSchedulerPacket({
          room: roomSnapshot,
          participant: nextParticipant,
          messages: unseenMessages,
          requestId,
          hasNewDelta: unseenMessages.length > 0,
        });

        const result = await executeAgentTurn({
          roomId,
          agentId: nextParticipant.agentId ?? defaultAgentId,
          inputMessage: schedulerPacket,
          anchorMessageId: visibleTargetMessages[visibleTargetMessages.length - 1]?.id,
          runRequestId: requestId,
        });

        if (result.status !== "completed") {
          updateRoomState(roomId, (room) => ({
            ...room,
            scheduler: {
              ...room.scheduler,
              status: "idle",
              activeParticipantId: null,
              roundCount: 0,
            },
            updatedAt: createTimestamp(),
          }));
          return;
        }

        const latestSchedulerRun = schedulerRunsRef.current[roomId];
        if (latestSchedulerRun?.cycleId !== cycleId) {
          return;
        }

        updateRoomState(roomId, (room) => ({
          ...room,
          scheduler: {
            ...room.scheduler,
            agentCursorByParticipantId: {
              ...room.scheduler.agentCursorByParticipantId,
              [nextParticipant.id]: Math.max(room.scheduler.agentCursorByParticipantId[nextParticipant.id] ?? 0, cutoffSeq),
            },
            agentReceiptRevisionByParticipantId: {
              ...room.scheduler.agentReceiptRevisionByParticipantId,
              [nextParticipant.id]: room.receiptRevision,
            },
          },
          updatedAt: createTimestamp(),
        }));
      }
    },
    [defaultAgentId, executeAgentTurn, interruptRoomScheduler, maxRounds, roomsRef, schedulerRunsRef, updateRoomState],
  );

  useEffect(() => {
    runRoomSchedulerRef.current = runRoomScheduler;
  }, [runRoomScheduler]);

  const clearAllSchedulerRuns = useCallback(() => {
    schedulerRunsRef.current = {};
  }, [schedulerRunsRef]);

  return {
    interruptRoomScheduler,
    maybeStartSchedulerForRoomMessage,
    roomHasRunningAgent: roomIsRunning,
    runRoomScheduler,
    clearAllSchedulerRuns,
  };
}
