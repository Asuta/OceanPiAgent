import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  AgentRoomTurn,
  AgentSharedState,
  AssistantMessageMeta,
  MessageImageAttachment,
  RoomAgentId,
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

type MutableRef<T> = {
  current: T;
};

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
  ) => Promise<{ rooms: RoomSession[]; roomId?: string | null } | null | undefined>;
  refreshWorkspaceFromServer: () => Promise<{ version?: number; state?: RoomWorkspaceState } | null>;
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

      let activeTurnId: string | null = null;
      let activeTurnAgentId: RoomAgentId | null = null;
      const previewMessageIds = new Set<string>();
      const previewMessageRoomIdById = new Map<string, string>();
      const pendingPreviewMessagesById = new Map<string, RoomMessage>();
      let previewFlushTimer: number | null = null;

      const flushPreviewMessages = () => {
        if (previewFlushTimer !== null) {
          window.clearTimeout(previewFlushTimer);
          previewFlushTimer = null;
        }

        if (pendingPreviewMessagesById.size === 0) {
          return;
        }

        const pendingPreviewMessages = [...pendingPreviewMessagesById.values()];
        pendingPreviewMessagesById.clear();
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
          updateRoomStateEphemeral(previewRoomId, (room) => {
            let nextRoom = room;
            for (const message of messages) {
              nextRoom = upsertMessageToRoom(nextRoom, message);
            }
            return nextRoom;
          });
        }

        if (!activeTurnId || !activeTurnAgentId) {
          return;
        }

        updateAgentTurnsEphemeral(activeTurnAgentId, (turns) =>
          turns.map((turn) => {
            if (turn.id !== activeTurnId) {
              return turn;
            }

            let nextTurn = turn;
            for (const message of pendingPreviewMessages) {
              nextTurn = upsertRoomMessageInTurn(nextTurn, message);
            }
            return nextTurn;
          }),
        );
      };

      const schedulePreviewFlush = () => {
        if (previewFlushTimer !== null) {
          return;
        }

        previewFlushTimer = window.setTimeout(() => {
          flushPreviewMessages();
        }, ROOM_MESSAGE_PREVIEW_FLUSH_MS);
      };

      const clearPreviewMessage = (messageId: string) => {
        pendingPreviewMessagesById.delete(messageId);
        if (pendingPreviewMessagesById.size === 0 && previewFlushTimer !== null) {
          window.clearTimeout(previewFlushTimer);
          previewFlushTimer = null;
        }
      };

      try {
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

        await readRoomStream({
          response,
          shouldContinue: () => activeRoomStreamRequestIdsRef.current[roomId] === localRequestId,
          onTurnStart: (turn) => {
            activeTurnId = turn.id;
            activeTurnAgentId = turn.agent.id;
            setStreamingAgentIdsByRoomId((current) => ({
              ...current,
              [roomId]: turn.agent.id,
            }));
            updateAgentTurnsEphemeral(turn.agent.id, (turns) => mergeAgentTurns(turns, [turn]));
          },
          onTextDelta: (delta) => {
            if (!activeTurnId || !activeTurnAgentId) {
              return;
            }

            updateAgentTurnsEphemeral(activeTurnAgentId, (turns) =>
              turns.map((turn) => (turn.id === activeTurnId ? appendDraftDelta(turn, delta) : turn)),
            );
          },
          onTool: (tool) => {
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
            previewMessageIds.add(message.id);
            previewMessageRoomIdById.set(message.id, message.roomId);
            pendingPreviewMessagesById.set(message.id, message);
            schedulePreviewFlush();
          },
          onRoomMessage: (message) => {
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
            flushPreviewMessages();
            const finalTurn = event.turn;
            activeTurnId = finalTurn.id;
            activeTurnAgentId = finalTurn.agent.id;
            updateRoomStateEphemeral(roomId, (room) => (
              room.error
                ? {
                    ...room,
                    error: "",
                    updatedAt: createTimestamp(),
                  }
                : room
            ));

            const finalizedMessageIds = new Set(finalTurn.emittedMessages.map((message) => message.id));
            for (const previewMessageId of previewMessageIds) {
              if (finalizedMessageIds.has(previewMessageId)) {
                continue;
              }

              const previewRoomId = previewMessageRoomIdById.get(previewMessageId) ?? roomId;
              updateRoomStateEphemeral(previewRoomId, (room) => ({
                ...room,
                roomMessages: room.roomMessages.filter((message) => message.id !== previewMessageId),
                updatedAt: createTimestamp(),
              }));
            }

            updateAgentTurnsEphemeral(finalTurn.agent.id, (turns) => {
              const existingIndex = turns.findIndex((turn) => turn.id === finalTurn.id);
              if (existingIndex >= 0) {
                const nextTurns = [...turns];
                nextTurns[existingIndex] = finalTurn;
                return nextTurns;
              }

              return mergeAgentTurns(turns, [finalTurn]);
            });
            updateAgentState(finalTurn.agent.id, (state) => ({
              ...state,
              resolvedModel: event.resolvedModel,
              compatibility: event.compatibility,
              updatedAt: createTimestamp(),
            }));
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

        await refreshWorkspaceFromServer();
        clearDraftForRoom(roomId);
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
        }
      }
    },
    [
      applyReceiptUpdateToAllAgentConsolesEphemeral,
      clearDraftForRoom,
      defaultLocalParticipantId,
      normalizeAssistantMeta,
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
