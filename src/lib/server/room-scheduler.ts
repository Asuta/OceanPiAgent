import type { ChatSettings, RoomMessage, RoomSession, RoomWorkspaceState } from "@/lib/chat/types";
import { createAgentSharedState, createTimestamp, getEnabledAgentParticipants, sortRoomsByUpdatedAt } from "@/lib/chat/workspace-domain";
import { createSchedulerPacket, getNextAgentParticipant, getSchedulerVisibleTargetMessages } from "@/lib/chat/room-scheduler";
import { applyRoomTurnToWorkspace } from "@/lib/server/workspace-state";
import { loadWorkspaceEnvelope, mutateWorkspace } from "@/lib/server/workspace-store";
import { runRoomTurnNonStreaming } from "@/lib/server/room-runner";
import { createUuid } from "@/lib/utils/uuid";

export const DEFAULT_ROOM_SCHEDULER_MAX_ROUNDS = 20;

interface RoomSchedulerDependencies {
  loadWorkspaceEnvelope: typeof loadWorkspaceEnvelope;
  mutateWorkspace: typeof mutateWorkspace;
  runRoomTurnNonStreaming: typeof runRoomTurnNonStreaming;
}

type QueueWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

type RoomQueueState = {
  running: boolean;
  rerun: boolean;
  waiters: QueueWaiter[];
};

declare global {
  var __oceankingRoomSchedulerQueues: Map<string, RoomQueueState> | undefined;
}

const roomQueues = globalThis.__oceankingRoomSchedulerQueues ?? new Map<string, RoomQueueState>();
globalThis.__oceankingRoomSchedulerQueues = roomQueues;

function getQueueState(roomId: string): RoomQueueState {
  const existing = roomQueues.get(roomId);
  if (existing) {
    return existing;
  }

  const created: RoomQueueState = {
    running: false,
    rerun: false,
    waiters: [],
  };
  roomQueues.set(roomId, created);
  return created;
}

function updateRoom(workspace: RoomWorkspaceState, roomId: string, updater: (room: RoomSession) => RoomSession): RoomWorkspaceState {
  return {
    ...workspace,
    rooms: sortRoomsByUpdatedAt(workspace.rooms.map((room) => (room.id === roomId ? updater(room) : room))),
  };
}

function withIdleScheduler(room: RoomSession): RoomSession {
  return {
    ...room,
    scheduler: {
      ...room.scheduler,
      status: "idle",
      activeParticipantId: null,
      roundCount: 0,
    },
    updatedAt: createTimestamp(),
  };
}

function hasNewerVisibleActivity(room: RoomSession, participantId: string, cutoffSeq: number): boolean {
  return room.roomMessages.some((message) => message.seq > cutoffSeq && message.sender.id !== participantId);
}

function getSchedulerSettings(workspace: RoomWorkspaceState, agentId: string): ChatSettings {
  return workspace.agentStates[agentId]?.settings ?? createAgentSharedState().settings;
}

function collectAdditionalRoomIds(messages: RoomMessage[], targetRoomId: string): string[] {
  return [...new Set(messages.map((message) => message.roomId).filter((roomId) => roomId && roomId !== targetRoomId))];
}

export async function runRoomSchedulerNow(
  roomId: string,
  overrides: Partial<RoomSchedulerDependencies> = {},
): Promise<void> {
  const deps: RoomSchedulerDependencies = {
    loadWorkspaceEnvelope: overrides.loadWorkspaceEnvelope ?? loadWorkspaceEnvelope,
    mutateWorkspace: overrides.mutateWorkspace ?? mutateWorkspace,
    runRoomTurnNonStreaming: overrides.runRoomTurnNonStreaming ?? runRoomTurnNonStreaming,
  };

  let idlePassCount = 0;
  let dispatchedRounds = 0;

  while (true) {
    const workspaceEnvelope = await deps.loadWorkspaceEnvelope();
    const room = workspaceEnvelope.state.rooms.find((entry) => entry.id === roomId);
    if (!room) {
      return;
    }

    const nextParticipant = getNextAgentParticipant(room);
    const enabledAgents = getEnabledAgentParticipants(room);
    if (!nextParticipant || enabledAgents.length === 0 || room.archivedAt) {
      await deps.mutateWorkspace((workspace) => updateRoom(workspace, roomId, withIdleScheduler));
      return;
    }

    const nextAfterParticipant = getNextAgentParticipant(room, nextParticipant.id);
    const cutoffSeq = room.roomMessages[room.roomMessages.length - 1]?.seq ?? 0;
    const lastCursor = room.scheduler.agentCursorByParticipantId[nextParticipant.id] ?? 0;
    const unseenMessages = room.roomMessages.filter(
      (message) => message.seq > lastCursor && message.seq <= cutoffSeq && message.sender.id !== nextParticipant.id,
    );
    const visibleTargetMessages = getSchedulerVisibleTargetMessages(unseenMessages, nextParticipant);

    await deps.mutateWorkspace((workspace) =>
      updateRoom(workspace, roomId, (currentRoom) => ({
        ...currentRoom,
        scheduler: {
          ...currentRoom.scheduler,
          status: "running",
          activeParticipantId: visibleTargetMessages.length > 0 ? nextParticipant.id : null,
          nextAgentParticipantId: nextAfterParticipant?.id ?? nextParticipant.id,
          roundCount: dispatchedRounds,
        },
        error: "",
        updatedAt: createTimestamp(),
      })),
    );

    if (visibleTargetMessages.length === 0) {
      await deps.mutateWorkspace((workspace) =>
        updateRoom(workspace, roomId, (currentRoom) => ({
          ...currentRoom,
          scheduler: {
            ...currentRoom.scheduler,
            activeParticipantId: null,
            agentCursorByParticipantId: {
              ...currentRoom.scheduler.agentCursorByParticipantId,
              [nextParticipant.id]: cutoffSeq,
            },
            agentReceiptRevisionByParticipantId: {
              ...currentRoom.scheduler.agentReceiptRevisionByParticipantId,
              [nextParticipant.id]: currentRoom.receiptRevision,
            },
          },
          updatedAt: createTimestamp(),
        })),
      );

      idlePassCount += 1;
      if (idlePassCount >= enabledAgents.length) {
        await deps.mutateWorkspace((workspace) => updateRoom(workspace, roomId, withIdleScheduler));
        return;
      }
      continue;
    }

    idlePassCount = 0;
    dispatchedRounds += 1;
    if (dispatchedRounds > DEFAULT_ROOM_SCHEDULER_MAX_ROUNDS) {
      await deps.mutateWorkspace((workspace) =>
        updateRoom(workspace, roomId, (currentRoom) => ({
          ...withIdleScheduler(currentRoom),
          error: `Room scheduler stopped after ${DEFAULT_ROOM_SCHEDULER_MAX_ROUNDS} agent rounds.`,
          updatedAt: createTimestamp(),
        })),
      );
      return;
    }

    const requestId = createUuid();
    const schedulerPacket = createSchedulerPacket({
      room,
      participant: nextParticipant,
      messages: unseenMessages,
      requestId,
      hasNewDelta: unseenMessages.length > 0,
    });
    const targetAgentId = nextParticipant.agentId ?? room.agentId;
    const result = await deps.runRoomTurnNonStreaming({
      workspace: workspaceEnvelope.state,
      roomId,
      agentId: targetAgentId,
      message: schedulerPacket,
      anchorMessageId: visibleTargetMessages[visibleTargetMessages.length - 1]?.id,
      settings: getSchedulerSettings(workspaceEnvelope.state, targetAgentId),
    });

    const latestWorkspace = await deps.loadWorkspaceEnvelope();
    const latestRoom = latestWorkspace.state.rooms.find((entry) => entry.id === roomId);
    if (!latestRoom) {
      return;
    }

    if (hasNewerVisibleActivity(latestRoom, nextParticipant.id, cutoffSeq)) {
      continue;
    }

    await deps.mutateWorkspace((workspace) => {
      const appliedWorkspace = applyRoomTurnToWorkspace({
        workspace,
        agentId: targetAgentId,
        targetRoomId: roomId,
        turn: result.turn,
        resolvedModel: result.resolvedModel,
        compatibility: result.compatibility,
        emittedMessages: result.emittedMessages,
        receiptUpdates: result.receiptUpdates,
        roomActions: result.roomActions,
      });

      return updateRoom(appliedWorkspace, roomId, (currentRoom) => ({
        ...currentRoom,
        scheduler: {
          ...currentRoom.scheduler,
          status: result.turn.status === "completed" ? "running" : "idle",
          activeParticipantId: null,
          nextAgentParticipantId: nextAfterParticipant?.id ?? nextParticipant.id,
          roundCount: result.turn.status === "completed" ? dispatchedRounds : 0,
          agentCursorByParticipantId: {
            ...currentRoom.scheduler.agentCursorByParticipantId,
            [nextParticipant.id]: Math.max(currentRoom.scheduler.agentCursorByParticipantId[nextParticipant.id] ?? 0, cutoffSeq),
          },
          agentReceiptRevisionByParticipantId: {
            ...currentRoom.scheduler.agentReceiptRevisionByParticipantId,
            [nextParticipant.id]: currentRoom.receiptRevision,
          },
        },
        updatedAt: createTimestamp(),
      }));
    });

    for (const additionalRoomId of collectAdditionalRoomIds(result.emittedMessages, roomId)) {
      void enqueueRoomScheduler(additionalRoomId, overrides);
    }

    if (result.turn.status !== "completed") {
      await deps.mutateWorkspace((workspace) => updateRoom(workspace, roomId, withIdleScheduler));
      return;
    }
  }
}

export function enqueueRoomScheduler(
  roomId: string,
  overrides: Partial<RoomSchedulerDependencies> = {},
): Promise<void> {
  const queueState = getQueueState(roomId);
  queueState.rerun = true;

  const completion = new Promise<void>((resolve, reject) => {
    queueState.waiters.push({ resolve, reject });
  });

  if (queueState.running) {
    return completion;
  }

  queueState.running = true;
  void (async () => {
    try {
      while (queueState.rerun) {
        queueState.rerun = false;
        await runRoomSchedulerNow(roomId, overrides);
      }

      const waiters = queueState.waiters.splice(0, queueState.waiters.length);
      waiters.forEach((waiter) => waiter.resolve());
    } catch (error) {
      const waiters = queueState.waiters.splice(0, queueState.waiters.length);
      waiters.forEach((waiter) => waiter.reject(error));
    } finally {
      queueState.running = false;
      if (queueState.rerun) {
        void enqueueRoomScheduler(roomId, overrides);
      }
    }
  })();

  return completion;
}
