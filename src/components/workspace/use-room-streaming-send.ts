import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  AgentRoomTurn,
  AgentSharedState,
  AssistantMessageMeta,
  MessageImageAttachment,
  RoomAgentId,
  RoomChatStreamEvent,
  RoomMessage,
  RoomMessageReceiptUpdate,
  RoomSession,
  RoomWorkspaceState,
} from "@/lib/chat/types";
import { applyMessageReceiptUpdate, createTimestamp, upsertMessageToRoom } from "@/lib/chat/workspace-domain";
import { hasMessagePayload } from "@/lib/chat/message-attachments";
import { createUuid } from "@/lib/utils/uuid";
import { readRoomStream } from "@/components/workspace/room-stream";
import { upsertRoomMessageInTurn } from "@/components/workspace/room-turn-state";
import { appendDraftDelta, appendTimelineEvent, finalizeLatestDraftSegment, mergeAgentTurns } from "@/components/workspace/agent-turn-state";

const ROOM_MESSAGE_PREVIEW_FLUSH_MS = 75;
const ROOM_STREAM_IDLE_RECONCILE_MS = 15_000;

type RoomUiTimingEntry = {
  roomId: string;
  requestId: string;
  phase: string;
  elapsedMs: number;
  details?: Record<string, string | number | boolean | null>;
};

declare global {
  interface Window {
    __oceankingRoomUiTimingLog?: RoomUiTimingEntry[];
  }
}

function recordRoomUiTiming(args: {
  roomId: string;
  requestId: string;
  phase: string;
  startedAt: number;
  details?: Record<string, string | number | boolean | null | undefined>;
}) {
  if (typeof window === "undefined") {
    return;
  }

  const entry: RoomUiTimingEntry = {
    roomId: args.roomId,
    requestId: args.requestId,
    phase: args.phase,
    elapsedMs: Math.round((performance.now() - args.startedAt) * 10) / 10,
    ...(args.details
      ? {
          details: Object.fromEntries(
            Object.entries(args.details).filter(([, value]) => typeof value !== "undefined"),
          ) as Record<string, string | number | boolean | null>,
        }
      : {}),
  };

  window.__oceankingRoomUiTimingLog = [...(window.__oceankingRoomUiTimingLog ?? []), entry].slice(-400);
  console.info("[room-ui-timing]", entry);
}

type MutableRef<T> = {
  current: T;
};

type DoneRoomStreamEvent = Extract<RoomChatStreamEvent, { type: "done" }>;
type UpdateRoomStateEphemeral = (roomId: string, updater: (room: RoomSession) => RoomSession) => void;
type UpdateAgentTurnsEphemeral = (agentId: RoomAgentId, updater: (turns: AgentRoomTurn[]) => AgentRoomTurn[]) => void;
type UpdateAgentState = (agentId: RoomAgentId, updater: (state: AgentSharedState) => AgentSharedState) => void;

function flushPendingPreviewMessages(args: {
  pendingPreviewMessagesById: Map<string, RoomMessage>;
  activeTurnId: string | null;
  activeTurnAgentId: RoomAgentId | null;
  updateRoomStateEphemeral: UpdateRoomStateEphemeral;
  updateAgentTurnsEphemeral: UpdateAgentTurnsEphemeral;
}): void {
  if (args.pendingPreviewMessagesById.size === 0) {
    return;
  }

  const pendingPreviewMessages = [...args.pendingPreviewMessagesById.values()];
  args.pendingPreviewMessagesById.clear();
  const pendingPreviewMessagesByRoomId = new Map<string, typeof pendingPreviewMessages>();

  for (const message of pendingPreviewMessages) {
    const roomMessages = pendingPreviewMessagesByRoomId.get(message.roomId);
    if (roomMessages) {
      roomMessages.push(message);
      continue;
    }

    pendingPreviewMessagesByRoomId.set(message.roomId, [message]);
  }

  for (const [previewRoomId, messages] of pendingPreviewMessagesByRoomId) {
    args.updateRoomStateEphemeral(previewRoomId, (room) => {
      let nextRoom = room;
      for (const message of messages) {
        nextRoom = upsertMessageToRoom(nextRoom, message);
      }
      return nextRoom;
    });
  }

  if (!args.activeTurnId || !args.activeTurnAgentId) {
    return;
  }

  args.updateAgentTurnsEphemeral(args.activeTurnAgentId, (turns) =>
    turns.map((turn) => {
      if (turn.id !== args.activeTurnId) {
        return turn;
      }

      let nextTurn = turn;
      for (const message of pendingPreviewMessages) {
        nextTurn = upsertRoomMessageInTurn(nextTurn, message);
      }
      return nextTurn;
    }),
  );
}

function removeUnfinalizedPreviewMessages(args: {
  roomId: string;
  finalTurn: DoneRoomStreamEvent["turn"];
  previewMessageIds: Set<string>;
  previewMessageRoomIdById: Map<string, string>;
  updateRoomStateEphemeral: UpdateRoomStateEphemeral;
}): void {
  const finalizedMessageIds = new Set(args.finalTurn.emittedMessages.map((message) => message.id));
  for (const previewMessageId of args.previewMessageIds) {
    if (finalizedMessageIds.has(previewMessageId)) {
      continue;
    }

    const previewRoomId = args.previewMessageRoomIdById.get(previewMessageId) ?? args.roomId;
    args.updateRoomStateEphemeral(previewRoomId, (room) => ({
      ...room,
      roomMessages: room.roomMessages.filter((message) => message.id !== previewMessageId),
      updatedAt: createTimestamp(),
    }));
  }
}

function reconcileCompletedStreamTurn(args: {
  roomId: string;
  event: DoneRoomStreamEvent;
  previewMessageIds: Set<string>;
  previewMessageRoomIdById: Map<string, string>;
  updateRoomStateEphemeral: UpdateRoomStateEphemeral;
  updateAgentTurnsEphemeral: UpdateAgentTurnsEphemeral;
  updateAgentState: UpdateAgentState;
}): DoneRoomStreamEvent["turn"] {
  const finalTurn = args.event.turn;
  args.updateRoomStateEphemeral(args.roomId, (room) => ({
    ...room,
    scheduler: args.event.roomRunning
      ? room.scheduler
      : {
          ...room.scheduler,
          status: "idle",
          activeParticipantId: null,
          roundCount: 0,
        },
    roomMessages: room.roomMessages.map((message) =>
      message.id === finalTurn.userMessage.id ? finalTurn.userMessage : message,
    ),
    error: "",
    updatedAt: createTimestamp(),
  }));

  removeUnfinalizedPreviewMessages({
    roomId: args.roomId,
    finalTurn,
    previewMessageIds: args.previewMessageIds,
    previewMessageRoomIdById: args.previewMessageRoomIdById,
    updateRoomStateEphemeral: args.updateRoomStateEphemeral,
  });

  args.updateAgentTurnsEphemeral(finalTurn.agent.id, (turns) => {
    const existingIndex = turns.findIndex((turn) => turn.id === finalTurn.id);
    if (existingIndex >= 0) {
      const nextTurns = [...turns];
      nextTurns[existingIndex] = finalTurn;
      return nextTurns;
    }

    return mergeAgentTurns(turns, [finalTurn]);
  });
  args.updateAgentState(finalTurn.agent.id, (state) => ({
    ...state,
    resolvedModel: args.event.resolvedModel,
    compatibility: args.event.compatibility,
    updatedAt: createTimestamp(),
  }));

  return finalTurn;
}

function isRoomStreamAuthoritativelyRunning(state: RoomWorkspaceState, roomId: string): boolean {
  const room = state.rooms.find((entry) => entry.id === roomId);
  if (!room) {
    return false;
  }

  if (room.scheduler.status === "running" || room.agentTurns.some((turn) => turn.status === "running")) {
    return true;
  }

  return Object.values(state.agentStates).some((agentState) =>
    agentState.agentTurns.some((turn) => turn.userMessage.roomId === roomId && turn.status === "running"),
  );
}

interface SendMessageArgs {
  roomId: string;
  content: string;
  attachments?: MessageImageAttachment[];
  senderId?: string;
}

export function useRoomStreamingSend(args: {
  defaultLocalParticipantId: string;
  roomsRef: MutableRef<RoomSession[]>;
  runRoomCommandRequest: (
    payload: Record<string, unknown>,
    options?: {
      pendingRoomId?: string;
    },
  ) => Promise<RoomWorkspaceState | null | undefined>;
  refreshWorkspaceFromServer: () => Promise<{ version?: number; state?: RoomWorkspaceState } | null>;
  flushWorkspacePersistence?: () => Promise<void>;
  clearDraftForRoom: (roomId: string) => void;
  setActiveRoomId: (roomId: string) => void;
  setSelectedSender: (roomId: string, participantId: string) => void;
  setPendingRoomCommandIds: Dispatch<SetStateAction<Record<string, boolean>>>;
  updateAgentState: (agentId: RoomAgentId, updater: (state: AgentSharedState) => AgentSharedState) => void;
  updateAgentTurnsEphemeral: (agentId: RoomAgentId, updater: (turns: AgentRoomTurn[]) => AgentRoomTurn[]) => void;
  updateRoomStateEphemeral: (roomId: string, updater: (room: RoomSession) => RoomSession) => void;
  applyReceiptUpdateToAllAgentConsolesEphemeral: (update: RoomMessageReceiptUpdate) => void;
  normalizeAssistantMeta: (value: unknown) => AgentRoomTurn["meta"] | undefined;
}) {
  const {
    defaultLocalParticipantId,
    roomsRef,
    runRoomCommandRequest,
    refreshWorkspaceFromServer,
    flushWorkspacePersistence,
    clearDraftForRoom,
    setActiveRoomId,
    setSelectedSender,
    setPendingRoomCommandIds,
    updateAgentState,
    updateAgentTurnsEphemeral,
    updateRoomStateEphemeral,
    applyReceiptUpdateToAllAgentConsolesEphemeral,
    normalizeAssistantMeta,
  } = args;

  const [streamingAgentIdsByRoomId, setStreamingAgentIdsByRoomId] = useState<Record<string, RoomAgentId>>({});
  const activeRoomStreamRequestIdsRef = useRef<Record<string, string>>({});
  const activeRoomStreamControllersRef = useRef<Record<string, AbortController>>({});

  useEffect(() => {
    return () => {
      for (const controller of Object.values(activeRoomStreamControllersRef.current)) {
        controller.abort();
      }
      activeRoomStreamControllersRef.current = {};
    };
  }, []);

  const stopRoom = useCallback(
    async (roomId: string) => {
      activeRoomStreamControllersRef.current[roomId]?.abort();
      delete activeRoomStreamRequestIdsRef.current[roomId];
      setStreamingAgentIdsByRoomId((current) => {
        const nextState = { ...current };
        delete nextState[roomId];
        return nextState;
      });
      await runRoomCommandRequest(
        {
          type: "stop_room",
          roomId,
        },
        { pendingRoomId: roomId },
      );
    },
    [runRoomCommandRequest],
  );

  const sendMessage = useCallback(
    async ({ roomId, content, attachments = [], senderId }: SendMessageArgs) => {
      const roomSnapshot = roomsRef.current.find((room) => room.id === roomId && !room.archivedAt);
      if (!roomSnapshot) {
        return;
      }

      const normalizedContent = content.trim();
      if (!hasMessagePayload(normalizedContent, attachments)) {
        return;
      }

      setActiveRoomId(roomId);
      setSelectedSender(roomId, senderId ?? defaultLocalParticipantId);
      const localRequestId = createUuid();
      activeRoomStreamControllersRef.current[roomId]?.abort();
      const requestController = new AbortController();
      activeRoomStreamControllersRef.current[roomId] = requestController;
      activeRoomStreamRequestIdsRef.current[roomId] = localRequestId;
      setPendingRoomCommandIds((current) => ({
        ...current,
        [roomId]: true,
      }));
      const uiTimingStartedAt = performance.now();
      let firstPreviewLogged = false;
      let firstFinalRoomMessageLogged = false;
      let doneLogged = false;
      recordRoomUiTiming({
        roomId,
        requestId: localRequestId,
        phase: "send_start",
        startedAt: uiTimingStartedAt,
        details: {
          contentChars: normalizedContent.length,
          attachmentCount: attachments.length,
        },
      });

      let activeTurnId: string | null = null;
      let activeTurnAgentId: RoomAgentId | null = null;
      const previewMessageIds = new Set<string>();
      const previewMessageRoomIdById = new Map<string, string>();
      const pendingPreviewMessagesById = new Map<string, RoomMessage>();
      let previewFlushTimer: number | null = null;
      let idleReconcileTimer: number | null = null;

      const flushPreviewMessages = () => {
        if (previewFlushTimer !== null) {
          window.clearTimeout(previewFlushTimer);
          previewFlushTimer = null;
        }

        flushPendingPreviewMessages({
          pendingPreviewMessagesById,
          activeTurnId,
          activeTurnAgentId,
          updateRoomStateEphemeral,
          updateAgentTurnsEphemeral,
        });
      };

      const schedulePreviewFlush = () => {
        if (previewFlushTimer !== null) {
          return;
        }

        previewFlushTimer = window.setTimeout(() => {
          flushPreviewMessages();
        }, ROOM_MESSAGE_PREVIEW_FLUSH_MS);
      };

      const clearIdleReconcileTimer = () => {
        if (idleReconcileTimer !== null) {
          window.clearTimeout(idleReconcileTimer);
          idleReconcileTimer = null;
        }
      };

      const scheduleIdleReconcile = () => {
        clearIdleReconcileTimer();
        idleReconcileTimer = window.setTimeout(() => {
          void (async () => {
            if (requestController.signal.aborted || activeRoomStreamRequestIdsRef.current[roomId] !== localRequestId) {
              return;
            }

            const payload = await refreshWorkspaceFromServer().catch(() => null);
            if (requestController.signal.aborted || activeRoomStreamRequestIdsRef.current[roomId] !== localRequestId) {
              return;
            }

            if (payload?.state && !isRoomStreamAuthoritativelyRunning(payload.state, roomId)) {
              requestController.abort(new Error("Room stream reconciled from workspace state."));
              return;
            }

            scheduleIdleReconcile();
          })();
        }, ROOM_STREAM_IDLE_RECONCILE_MS);
      };

      const clearPreviewMessage = (messageId: string) => {
        pendingPreviewMessagesById.delete(messageId);
        if (pendingPreviewMessagesById.size === 0 && previewFlushTimer !== null) {
          window.clearTimeout(previewFlushTimer);
          previewFlushTimer = null;
        }
      };

      try {
        await flushWorkspacePersistence?.();

        const response = await fetch("/api/rooms/stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          signal: requestController.signal,
          body: JSON.stringify({
            roomId,
            content: normalizedContent,
            attachments,
            ...(senderId ? { senderId } : {}),
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error || "The room stream returned an unknown error.");
        }

        scheduleIdleReconcile();

        await readRoomStream({
          response,
          shouldContinue: () => activeRoomStreamRequestIdsRef.current[roomId] === localRequestId,
          onTurnStart: (turn) => {
            scheduleIdleReconcile();
            activeTurnId = turn.id;
            activeTurnAgentId = turn.agent.id;
            setStreamingAgentIdsByRoomId((current) => ({
              ...current,
              [roomId]: turn.agent.id,
            }));
            updateAgentTurnsEphemeral(turn.agent.id, (turns) => mergeAgentTurns(turns, [turn]));
          },
          onTextDelta: (delta) => {
            scheduleIdleReconcile();
            if (!activeTurnId || !activeTurnAgentId) {
              return;
            }

            updateAgentTurnsEphemeral(activeTurnAgentId, (turns) =>
              turns.map((turn) => (turn.id === activeTurnId ? appendDraftDelta(turn, delta) : turn)),
            );
          },
          onTool: (tool) => {
            scheduleIdleReconcile();
            if (!activeTurnId || !activeTurnAgentId) {
              return;
            }

            updateAgentTurnsEphemeral(activeTurnAgentId, (turns) =>
              turns.map((turn) =>
                turn.id === activeTurnId
                  ? {
                      ...appendTimelineEvent(finalizeLatestDraftSegment(turn), {
                        id: `tool:${tool.id}`,
                        sequence: (turn.timeline?.length ?? 0) + 1,
                        type: "tool",
                        toolId: tool.id,
                      }),
                      tools: [...turn.tools, tool],
                    }
                  : turn,
              ),
            );
          },
          onRoomMessagePreview: (message) => {
            scheduleIdleReconcile();
            if (!firstPreviewLogged) {
              firstPreviewLogged = true;
              recordRoomUiTiming({
                roomId,
                requestId: localRequestId,
                phase: "preview_first",
                startedAt: uiTimingStartedAt,
                details: {
                  previewRoomId: message.roomId,
                  contentChars: message.content.length,
                  final: message.final,
                  status: message.status,
                },
              });
            }
            previewMessageIds.add(message.id);
            previewMessageRoomIdById.set(message.id, message.roomId);
            pendingPreviewMessagesById.set(message.id, message);
            schedulePreviewFlush();
          },
          onRoomMessage: (message) => {
            scheduleIdleReconcile();
            if (!firstFinalRoomMessageLogged && message.role === "assistant" && message.status === "completed" && message.final) {
              firstFinalRoomMessageLogged = true;
              recordRoomUiTiming({
                roomId,
                requestId: localRequestId,
                phase: "final_room_message",
                startedAt: uiTimingStartedAt,
                details: {
                  finalRoomId: message.roomId,
                  contentChars: message.content.length,
                  kind: message.kind,
                },
              });
            }
            previewMessageIds.delete(message.id);
            previewMessageRoomIdById.delete(message.id);
            clearPreviewMessage(message.id);
            updateRoomStateEphemeral(message.roomId, (room) => upsertMessageToRoom(room, message));
            if (!activeTurnId || !activeTurnAgentId) {
              return;
            }

            updateAgentTurnsEphemeral(activeTurnAgentId, (turns) =>
              turns.map((turn) => (turn.id === activeTurnId ? upsertRoomMessageInTurn(turn, message) : turn)),
            );
          },
          onReceiptUpdate: (update) => {
            scheduleIdleReconcile();
            updateRoomStateEphemeral(update.roomId, (room) => {
              const nextMessages = applyMessageReceiptUpdate(room.roomMessages, update);
              if (nextMessages === room.roomMessages) {
                return room;
              }

              return {
                ...room,
                roomMessages: nextMessages,
                receiptRevision: room.receiptRevision + 1,
                updatedAt: createTimestamp(),
              };
            });
            applyReceiptUpdateToAllAgentConsolesEphemeral(update);
          },
          onDone: (event) => {
            clearIdleReconcileTimer();
            if (!doneLogged) {
              doneLogged = true;
              recordRoomUiTiming({
                roomId,
                requestId: localRequestId,
                phase: "stream_done",
                startedAt: uiTimingStartedAt,
                details: {
                  turnStatus: event.turn.status,
                  emittedMessages: event.turn.emittedMessages.length,
                },
              });
            }
            flushPreviewMessages();
            const finalTurn = reconcileCompletedStreamTurn({
              roomId,
              event,
              previewMessageIds,
              previewMessageRoomIdById,
              updateRoomStateEphemeral,
              updateAgentTurnsEphemeral,
              updateAgentState,
            });
            activeTurnId = finalTurn.id;
            activeTurnAgentId = finalTurn.agent.id;
          },
          onMeta: (meta: AssistantMessageMeta) => {
            const normalizedMeta = normalizeAssistantMeta(meta);
            if (!normalizedMeta || !activeTurnId || !activeTurnAgentId) {
              return;
            }

            updateAgentTurnsEphemeral(activeTurnAgentId, (turns) =>
              turns.map((turn) => (turn.id === activeTurnId ? { ...turn, meta: normalizedMeta } : turn)),
            );
          },
        });

        recordRoomUiTiming({
          roomId,
          requestId: localRequestId,
          phase: "stream_reader_complete",
          startedAt: uiTimingStartedAt,
        });

        clearDraftForRoom(roomId);
        void refreshWorkspaceFromServer()
          .then(() => {
            recordRoomUiTiming({
              roomId,
              requestId: localRequestId,
              phase: "refresh_done",
              startedAt: uiTimingStartedAt,
            });
          })
          .catch(() => undefined);
      } catch (error) {
        if (requestController.signal.aborted) {
          return;
        }

        throw error;
      } finally {
        if (previewFlushTimer !== null) {
          window.clearTimeout(previewFlushTimer);
          previewFlushTimer = null;
        }
        clearIdleReconcileTimer();
        pendingPreviewMessagesById.clear();
        if (activeRoomStreamControllersRef.current[roomId] === requestController) {
          delete activeRoomStreamControllersRef.current[roomId];
        }
        const isCurrentRequest = activeRoomStreamRequestIdsRef.current[roomId] === localRequestId;
        if (isCurrentRequest) {
          delete activeRoomStreamRequestIdsRef.current[roomId];
          setPendingRoomCommandIds((current) => {
            const nextState = { ...current };
            delete nextState[roomId];
            return nextState;
          });
          setStreamingAgentIdsByRoomId((current) => {
            const nextState = { ...current };
            delete nextState[roomId];
            return nextState;
          });
          recordRoomUiTiming({
            roomId,
            requestId: localRequestId,
            phase: "ui_cleanup",
            startedAt: uiTimingStartedAt,
          });
        }
      }
    },
    [
      applyReceiptUpdateToAllAgentConsolesEphemeral,
      clearDraftForRoom,
      defaultLocalParticipantId,
      normalizeAssistantMeta,
      flushWorkspacePersistence,
      refreshWorkspaceFromServer,
      roomsRef,
      setActiveRoomId,
      setPendingRoomCommandIds,
      setSelectedSender,
      updateAgentState,
      updateAgentTurnsEphemeral,
      updateRoomStateEphemeral,
    ],
  );

  return {
    streamingAgentIdsByRoomId,
    stopRoom,
    sendMessage,
  };
}
