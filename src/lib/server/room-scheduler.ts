import type {
  AgentRoomTurn,
  AssistantMessageMeta,
  ChatSettings,
  RoomMessage,
  RoomSession,
  RoomWorkspaceState,
  ToolExecution,
} from "@/lib/chat/types";
import { createSchedulerPacket } from "@/lib/chat/room-scheduler";
import { createAgentSharedState, createTimestamp, sortRoomsForDisplay } from "@/lib/chat/workspace-domain";
import { deliverBoundRoomMessages } from "@/lib/server/channel-outbound-service";
import { abortRoomStream, combineAbortSignals } from "@/lib/server/room-stream-control";
import {
  buildPreparedInputFromWorkspace,
  extractAssistantMetaFromRoomTurnError,
  runPreparedRoomTurn,
  runRoomTurnNonStreaming,
  type RunRoomTurnResult,
} from "@/lib/server/room-runner";
import { applyRoomTurnToWorkspace } from "@/lib/server/workspace-state";
import { resolveSettingsWithModelConfig } from "@/lib/server/model-config-store";
import { loadWorkspaceEnvelope, mutateWorkspace } from "@/lib/server/workspace-store";
import { hasSupersedingVisibleActivity, planSchedulerRound } from "@/lib/server/room-scheduler-planner";
import { createUuid } from "@/lib/utils/uuid";

export const DEFAULT_ROOM_SCHEDULER_MAX_ROUNDS = 20;

export interface RoomSchedulerRunHooks {
  signal?: AbortSignal;
  onTurnStart?: (turn: AgentRoomTurn) => void | Promise<void>;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onTool?: (tool: ToolExecution) => void | Promise<void>;
  onRoomMessagePreview?: (message: RoomMessage) => void | Promise<void>;
  onRoomMessage?: (message: RoomMessage) => void | Promise<void>;
  onReceiptUpdate?: (update: RunRoomTurnResult["receiptUpdates"][number]) => void | Promise<void>;
  onTurnDone?: (result: RunRoomTurnResult) => void | Promise<void>;
  onError?: (error: unknown, meta?: AssistantMessageMeta) => void | Promise<void>;
}

interface RoomSchedulerDependencies {
  loadWorkspaceEnvelope: typeof loadWorkspaceEnvelope;
  mutateWorkspace: typeof mutateWorkspace;
  runRoomTurnNonStreaming: typeof runRoomTurnNonStreaming;
  runPreparedRoomTurn: typeof runPreparedRoomTurn;
  buildPreparedInputFromWorkspace: typeof buildPreparedInputFromWorkspace;
  resolveSettingsWithModelConfig: typeof resolveSettingsWithModelConfig;
  deliverBoundRoomMessages: typeof deliverBoundRoomMessages;
}

type QueueWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

type RoomSchedulerOverrides = Partial<RoomSchedulerDependencies & RoomSchedulerRunHooks>;

type RoomQueueState = {
  running: boolean;
  rerun: boolean;
  waiters: QueueWaiter[];
  activeOverrides?: RoomSchedulerOverrides;
  queuedOverrides?: RoomSchedulerOverrides;
  currentRunController?: AbortController;
};

declare global {
  var __oceankingRoomSchedulerQueues: Map<string, RoomQueueState> | undefined;
}

const roomQueues = globalThis.__oceankingRoomSchedulerQueues ?? new Map<string, RoomQueueState>();
globalThis.__oceankingRoomSchedulerQueues = roomQueues;

function createQueueState(): RoomQueueState {
  return {
    running: false,
    rerun: false,
    waiters: [],
    activeOverrides: undefined,
    queuedOverrides: undefined,
    currentRunController: undefined,
  };
}

function getQueueState(roomId: string): RoomQueueState {
  const existing = roomQueues.get(roomId);
  if (existing) {
    return existing;
  }

  const created = createQueueState();
  roomQueues.set(roomId, created);
  return created;
}

function mergeSchedulerOverrides(
  previous: RoomSchedulerOverrides | undefined,
  next: RoomSchedulerOverrides,
): RoomSchedulerOverrides {
  return {
    ...(previous ?? {}),
    ...next,
  };
}

function queueSchedulerRun(queueState: RoomQueueState, overrides: RoomSchedulerOverrides): void {
  queueState.rerun = true;
  queueState.queuedOverrides = mergeSchedulerOverrides(queueState.queuedOverrides ?? queueState.activeOverrides, overrides);
}

function settleQueueWaiters(queueState: RoomQueueState, error?: unknown): void {
  const waiters = queueState.waiters.splice(0, queueState.waiters.length);
  if (error === undefined) {
    waiters.forEach((waiter) => waiter.resolve());
    return;
  }

  waiters.forEach((waiter) => waiter.reject(error));
}

function updateRoom(workspace: RoomWorkspaceState, roomId: string, updater: (room: RoomSession) => RoomSession): RoomWorkspaceState {
  return {
    ...workspace,
    rooms: sortRoomsForDisplay(workspace.rooms.map((room) => (room.id === roomId ? updater(room) : room))),
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

function markTurnStopped(turn: AgentRoomTurn, reason: string): AgentRoomTurn {
  if (turn.status !== "running") {
    return turn;
  }

  return {
    ...turn,
    status: "error",
    error: reason,
  };
}

function applyStoppedStateToWorkspace(workspace: RoomWorkspaceState, roomId: string, reason: string): RoomWorkspaceState {
  const stoppedTurnIds = new Set<string>();
  const rooms = sortRoomsForDisplay(
    workspace.rooms.map((room) => {
      if (room.id !== roomId) {
        return room;
      }

      const nextTurns = room.agentTurns.map((turn) => {
        const nextTurn = markTurnStopped(turn, reason);
        if (nextTurn !== turn) {
          stoppedTurnIds.add(turn.id);
        }
        return nextTurn;
      });

      return {
        ...withIdleScheduler(room),
        agentTurns: nextTurns,
        error: "",
        updatedAt: createTimestamp(),
      };
    }),
  );

  if (stoppedTurnIds.size === 0) {
    return {
      ...workspace,
      rooms,
    };
  }

  const nextAgentStates = Object.fromEntries(
    Object.entries(workspace.agentStates).map(([agentId, state]) => [
      agentId,
      {
        ...state,
        agentTurns: state.agentTurns.map((turn) => (stoppedTurnIds.has(turn.id) ? markTurnStopped(turn, reason) : turn)),
        updatedAt: createTimestamp(),
      },
    ]),
  ) as RoomWorkspaceState["agentStates"];

  return {
    ...workspace,
    rooms,
    agentStates: nextAgentStates,
  };
}

function getAbortReason(signal: AbortSignal | undefined, fallback: string): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.trim()) {
    return reason;
  }
  return fallback;
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error && /abort|stopp|take over/i.test(error.message)) {
    return true;
  }
  return false;
}

function getSchedulerSettings(workspace: RoomWorkspaceState, agentId: string): ChatSettings {
  return workspace.agentStates[agentId]?.settings ?? createAgentSharedState().settings;
}

function collectAdditionalRoomIds(messages: RoomMessage[], targetRoomId: string): string[] {
  return [...new Set(messages.map((message) => message.roomId).filter((roomId) => roomId && roomId !== targetRoomId))];
}

function hasStreamingHooks(hooks: RoomSchedulerRunHooks): boolean {
  return Boolean(
    hooks.onTurnStart
      || hooks.onTextDelta
      || hooks.onTool
      || hooks.onRoomMessagePreview
      || hooks.onRoomMessage
      || hooks.onReceiptUpdate
      || hooks.onTurnDone
      || hooks.onError,
  );
}

function createPendingTurn(args: {
  turnId: string;
  agentId: string;
  agentLabel: string;
  schedulerPacket: AgentRoomTurn["userMessage"];
  anchorMessageId?: string;
}): AgentRoomTurn {
  return {
    id: args.turnId,
    agent: {
      id: args.agentId,
      label: args.agentLabel,
    },
    userMessage: args.schedulerPacket,
    ...(args.anchorMessageId ? { anchorMessageId: args.anchorMessageId } : {}),
    assistantContent: "",
    draftSegments: [],
    timeline: [],
    tools: [],
    emittedMessages: [],
    status: "running",
  };
}

async function emit<T>(callback: ((value: T) => void | Promise<void>) | undefined, value: T): Promise<void> {
  if (!callback) {
    return;
  }

  await callback(value);
}

async function executeScheduledTurn(args: {
  workspace: RoomWorkspaceState;
  room: RoomSession;
  targetAgentId: string;
  participant: RoomSession["participants"][number];
  unseenMessages: RoomMessage[];
  anchorMessageId?: string;
  hooks: RoomSchedulerRunHooks;
  deps: RoomSchedulerDependencies;
}): Promise<RunRoomTurnResult> {
  const resolvedSelection = await args.deps.resolveSettingsWithModelConfig(getSchedulerSettings(args.workspace, args.targetAgentId));

  if (!hasStreamingHooks(args.hooks)) {
    const schedulerPacket = createSchedulerPacket({
      room: args.room,
      participant: args.participant,
      messages: args.unseenMessages,
      requestId: createUuid(),
      hasNewDelta: args.unseenMessages.length > 0,
    });

    return args.deps.runRoomTurnNonStreaming({
      workspace: args.workspace,
      roomId: args.room.id,
      agentId: args.targetAgentId,
      message: schedulerPacket,
      anchorMessageId: args.anchorMessageId,
      settings: resolvedSelection.settings,
      modelConfigOverrides: resolvedSelection.modelConfigOverrides,
      ...(args.hooks.signal ? { signal: args.hooks.signal } : {}),
    });
  }

  const turnId = `stream:${createUuid()}`;
  const schedulerPacket = createSchedulerPacket({
    room: args.room,
    participant: args.participant,
    messages: args.unseenMessages,
    requestId: createUuid(),
    hasNewDelta: args.unseenMessages.length > 0,
  });

  await emit(
    args.hooks.onTurnStart,
    createPendingTurn({
      turnId,
      agentId: args.targetAgentId,
      agentLabel: args.participant.name,
      schedulerPacket,
      anchorMessageId: args.anchorMessageId,
    }),
  );

  const preparedInput = await args.deps.buildPreparedInputFromWorkspace({
    workspace: args.workspace,
    roomId: args.room.id,
    agentId: args.targetAgentId,
    turnId,
    message: schedulerPacket,
    anchorMessageId: args.anchorMessageId,
    settings: resolvedSelection.settings,
    ...(args.hooks.signal ? { signal: args.hooks.signal } : {}),
  });
  preparedInput.modelConfigOverrides = resolvedSelection.modelConfigOverrides;

  return args.deps.runPreparedRoomTurn(preparedInput, {
    onTextDelta: (delta) => emit(args.hooks.onTextDelta, delta),
    onTool: (tool) => emit(args.hooks.onTool, tool),
    onRoomMessagePreview: (message) => emit(args.hooks.onRoomMessagePreview, message),
    onRoomMessage: (message) => emit(args.hooks.onRoomMessage, message),
    onReceiptUpdate: (update) => emit(args.hooks.onReceiptUpdate, update),
  });
}

export async function runRoomSchedulerNow(
  roomId: string,
  overrides: RoomSchedulerOverrides = {},
): Promise<void> {
  const queueState = getQueueState(roomId);
  const combinedSignal = queueState.currentRunController
    ? combineAbortSignals([
        queueState.currentRunController.signal,
        ...(overrides.signal ? [overrides.signal] : []),
      ])
    : overrides.signal;
  const deps: RoomSchedulerDependencies = {
    loadWorkspaceEnvelope: overrides.loadWorkspaceEnvelope ?? loadWorkspaceEnvelope,
    mutateWorkspace: overrides.mutateWorkspace ?? mutateWorkspace,
    runRoomTurnNonStreaming: overrides.runRoomTurnNonStreaming ?? runRoomTurnNonStreaming,
    runPreparedRoomTurn: overrides.runPreparedRoomTurn ?? runPreparedRoomTurn,
    buildPreparedInputFromWorkspace: overrides.buildPreparedInputFromWorkspace ?? buildPreparedInputFromWorkspace,
    resolveSettingsWithModelConfig: overrides.resolveSettingsWithModelConfig ?? resolveSettingsWithModelConfig,
    deliverBoundRoomMessages: overrides.deliverBoundRoomMessages ?? deliverBoundRoomMessages,
  };
  const hooks: RoomSchedulerRunHooks = {
    ...(combinedSignal ? { signal: combinedSignal } : {}),
    ...(overrides.onTurnStart ? { onTurnStart: overrides.onTurnStart } : {}),
    ...(overrides.onTextDelta ? { onTextDelta: overrides.onTextDelta } : {}),
    ...(overrides.onTool ? { onTool: overrides.onTool } : {}),
    ...(overrides.onRoomMessagePreview ? { onRoomMessagePreview: overrides.onRoomMessagePreview } : {}),
    ...(overrides.onRoomMessage ? { onRoomMessage: overrides.onRoomMessage } : {}),
    ...(overrides.onReceiptUpdate ? { onReceiptUpdate: overrides.onReceiptUpdate } : {}),
    ...(overrides.onTurnDone ? { onTurnDone: overrides.onTurnDone } : {}),
    ...(overrides.onError ? { onError: overrides.onError } : {}),
  };

  let idlePassCount = 0;
  let dispatchedRounds = 0;

  while (true) {
    if (hooks.signal?.aborted) {
      await deps.mutateWorkspace((workspace) => applyStoppedStateToWorkspace(workspace, roomId, getAbortReason(hooks.signal, "Room scheduler stopped.")));
      return;
    }

    const workspaceEnvelope = await deps.loadWorkspaceEnvelope();
    const room = workspaceEnvelope.state.rooms.find((entry) => entry.id === roomId);
    if (!room) {
      return;
    }

    const roundPlan = planSchedulerRound(room);
    if (roundPlan.type === "idle") {
      await deps.mutateWorkspace((workspace) => updateRoom(workspace, roomId, withIdleScheduler));
      return;
    }

    await deps.mutateWorkspace((workspace) =>
      updateRoom(workspace, roomId, (currentRoom) => ({
        ...currentRoom,
        scheduler: {
          ...currentRoom.scheduler,
          status: "running",
          activeParticipantId: roundPlan.visibleTargetMessages.length > 0 ? roundPlan.participant.id : null,
          nextAgentParticipantId: roundPlan.nextAfterParticipantId,
          roundCount: dispatchedRounds,
        },
        error: "",
        updatedAt: createTimestamp(),
      })),
    );

    if (roundPlan.visibleTargetMessages.length === 0) {
      await deps.mutateWorkspace((workspace) =>
        updateRoom(workspace, roomId, (currentRoom) => ({
          ...currentRoom,
          scheduler: {
            ...currentRoom.scheduler,
            activeParticipantId: null,
            nextAgentParticipantId: roundPlan.nextAfterParticipantId,
            agentCursorByParticipantId: {
              ...currentRoom.scheduler.agentCursorByParticipantId,
              [roundPlan.participant.id]: roundPlan.cutoffSeq,
            },
            agentReceiptRevisionByParticipantId: {
              ...currentRoom.scheduler.agentReceiptRevisionByParticipantId,
              [roundPlan.participant.id]: currentRoom.receiptRevision,
            },
          },
          updatedAt: createTimestamp(),
        })),
      );

      idlePassCount += 1;
      if (idlePassCount >= roundPlan.enabledAgentCount) {
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

    const targetAgentId = roundPlan.participant.agentId ?? room.agentId;
    let result: RunRoomTurnResult;
    try {
      result = await executeScheduledTurn({
        workspace: workspaceEnvelope.state,
        room,
        targetAgentId,
        participant: roundPlan.participant,
        unseenMessages: roundPlan.unseenMessages,
        anchorMessageId: roundPlan.anchorMessageId,
        hooks,
        deps,
      });
    } catch (error) {
      if (isAbortLike(error, hooks.signal)) {
        await deps.mutateWorkspace((workspace) => applyStoppedStateToWorkspace(workspace, roomId, getAbortReason(hooks.signal, "Room scheduler stopped.")));
        return;
      }

      const meta = extractAssistantMetaFromRoomTurnError(error);
      if (hooks.onError) {
        await hooks.onError(error, meta);
      }
      throw error;
    }

    const latestWorkspace = await deps.loadWorkspaceEnvelope();
    const latestRoom = latestWorkspace.state.rooms.find((entry) => entry.id === roomId);
    if (!latestRoom) {
      return;
    }

    const wasSuperseded = hasSupersedingVisibleActivity(latestRoom, roundPlan.participant.id, roundPlan.cutoffSeq);
    if (!wasSuperseded) {
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
              nextAgentParticipantId: roundPlan.nextAfterParticipantId,
              roundCount: result.turn.status === "completed" ? dispatchedRounds : 0,
              agentCursorByParticipantId: {
                ...currentRoom.scheduler.agentCursorByParticipantId,
                [roundPlan.participant.id]: Math.max(
                  currentRoom.scheduler.agentCursorByParticipantId[roundPlan.participant.id] ?? 0,
                  roundPlan.cutoffSeq,
                ),
              },
              agentReceiptRevisionByParticipantId: {
                ...currentRoom.scheduler.agentReceiptRevisionByParticipantId,
                [roundPlan.participant.id]: currentRoom.receiptRevision,
              },
            },
            updatedAt: createTimestamp(),
        }));
      });

      await deps.deliverBoundRoomMessages(result.emittedMessages);
    }

    await emit(hooks.onTurnDone, result);

    for (const additionalRoomId of collectAdditionalRoomIds(result.emittedMessages, roomId)) {
      void enqueueRoomScheduler(additionalRoomId);
    }

    if (result.turn.status !== "completed") {
      await deps.mutateWorkspace((workspace) => updateRoom(workspace, roomId, withIdleScheduler));
      return;
    }
  }
}

export function enqueueRoomScheduler(
  roomId: string,
  overrides: RoomSchedulerOverrides = {},
): Promise<void> {
  const queueState = getQueueState(roomId);
  queueSchedulerRun(queueState, overrides);

  const completion = new Promise<void>((resolve, reject) => {
    queueState.waiters.push({ resolve, reject });
  });

  if (queueState.running) {
    return completion;
  }

  queueState.running = true;
  queueState.currentRunController = new AbortController();
  void (async () => {
    try {
      while (queueState.rerun) {
        const nextOverrides = queueState.queuedOverrides ?? overrides;
        queueState.rerun = false;
        queueState.queuedOverrides = undefined;
        queueState.activeOverrides = nextOverrides;
        await runRoomSchedulerNow(roomId, nextOverrides);
      }

      settleQueueWaiters(queueState);
    } catch (error) {
      settleQueueWaiters(queueState, error);
    } finally {
      queueState.running = false;
      queueState.activeOverrides = undefined;
      queueState.currentRunController = undefined;
      if (queueState.rerun) {
        void enqueueRoomScheduler(roomId, overrides);
      }
    }
  })();

  return completion;
}

export async function stopRoomScheduler(
  roomId: string,
  reason = "Room scheduler stopped by operator.",
  overrides: Partial<Pick<RoomSchedulerDependencies, "mutateWorkspace">> = {},
): Promise<void> {
  const queueState = getQueueState(roomId);
  queueState.rerun = false;
  queueState.queuedOverrides = undefined;
  queueState.currentRunController?.abort(new Error(reason));
  abortRoomStream(roomId, new Error(reason));
  const applyMutation = overrides.mutateWorkspace ?? mutateWorkspace;
  await applyMutation((workspace) => applyStoppedStateToWorkspace(workspace, roomId, reason));
}

export async function resetRoomSchedulerStateForTest(): Promise<void> {
  for (const queueState of roomQueues.values()) {
    queueState.currentRunController?.abort(new Error("Reset room scheduler test state."));
  }
  roomQueues.clear();
}

export function getRoomSchedulerQueueSnapshotForTest(roomId: string) {
  const queueState = roomQueues.get(roomId);
  if (!queueState) {
    return null;
  }

  return {
    running: queueState.running,
    rerun: queueState.rerun,
    activeOverrides: queueState.activeOverrides,
    queuedOverrides: queueState.queuedOverrides,
  };
}
