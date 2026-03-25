import { useCallback, useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  AgentInfoCard,
  AgentRoomTurn,
  AgentSharedState,
  AssistantMessageMeta,
  AttachedRoomDefinition,
  RoomAgentId,
  RoomChatResponseBody,
  RoomHistoryMessageSummary,
  RoomMessage,
  RoomMessageReceiptUpdate,
  RoomSession,
  RoomToolActionUnion,
} from "@/lib/chat/types";
import { createUuid } from "@/lib/utils/uuid";
import {
  appendMessageToRoom,
  applyMessageReceiptUpdate,
  createAgentSharedState,
  createTimestamp,
  getRoomAgent,
} from "@/lib/chat/workspace-domain";
import { readRoomStream as processRoomStream } from "@/components/workspace/room-stream";
import type { ActiveSchedulerRun } from "@/components/workspace/scheduler";

export interface ActiveRoomRun {
  roomId: string;
  requestId: string;
  turnId: string;
  controller: AbortController;
}

export interface ExecuteAgentTurnResult {
  status: "completed" | "superseded" | "aborted" | "error";
  emittedMessages: RoomMessage[];
  receiptUpdates: RoomMessageReceiptUpdate[];
}

function updateTurn(
  turns: AgentRoomTurn[],
  turnId: string,
  updater: (turn: AgentRoomTurn) => AgentRoomTurn,
): AgentRoomTurn[] {
  return turns.map((turn) => (turn.id === turnId ? updater(turn) : turn));
}

export function useRoomExecution(args: {
  roomsRef: MutableRefObject<RoomSession[]>;
  agentStatesRef: MutableRefObject<Record<RoomAgentId, AgentSharedState>>;
  activeRunsRef: MutableRefObject<Record<string, ActiveRoomRun>>;
  activeSchedulerRunsRef: MutableRefObject<Record<string, ActiveSchedulerRun>>;
  setRunningAgentRequestIds: Dispatch<SetStateAction<Record<string, string>>>;
  updateAgentTurns: (agentId: RoomAgentId, updater: (turns: AgentRoomTurn[]) => AgentRoomTurn[]) => void;
  updateRoomState: (roomId: string, updater: (room: RoomSession) => RoomSession) => void;
  updateAgentState: (agentId: RoomAgentId, updater: (state: AgentSharedState) => AgentSharedState) => void;
  applyReceiptUpdateToAllAgentConsoles: (update: RoomMessageReceiptUpdate) => void;
  applyRoomToolActions: (actions: RoomToolActionUnion[], actorAgentId: RoomAgentId) => void;
  getAttachedRoomsForAgent: (agentId: RoomAgentId, currentRoomId: string, currentRoomTitle: string) => AttachedRoomDefinition[];
  getKnownAgentsForToolContext: () => AgentInfoCard[];
  getRoomHistoryByIdForAgent: (agentId: RoomAgentId) => Record<string, RoomHistoryMessageSummary[]>;
  maybeStartSchedulerForRoomMessage: (roomId: string, message: RoomMessage) => void;
  mergeAgentTurns: (...turnGroups: AgentRoomTurn[][]) => AgentRoomTurn[];
  normalizeAssistantMeta: (value: unknown) => AssistantMessageMeta | undefined;
}) {
  const {
    roomsRef,
    agentStatesRef,
    activeRunsRef,
    activeSchedulerRunsRef,
    setRunningAgentRequestIds,
    updateAgentTurns,
    updateRoomState,
    updateAgentState,
    applyReceiptUpdateToAllAgentConsoles,
    applyRoomToolActions,
    getAttachedRoomsForAgent,
    getKnownAgentsForToolContext,
    getRoomHistoryByIdForAgent,
    maybeStartSchedulerForRoomMessage,
    mergeAgentTurns,
    normalizeAssistantMeta,
  } = args;

  const getActiveAgentRun = useCallback((agentId: RoomAgentId): ActiveRoomRun | null => {
    return activeRunsRef.current[agentId] ?? null;
  }, [activeRunsRef]);

  const isCurrentAgentRun = useCallback((agentId: RoomAgentId, requestId: string): boolean => {
    return activeRunsRef.current[agentId]?.requestId === requestId;
  }, [activeRunsRef]);

  const startAgentRun = useCallback((agentId: RoomAgentId, run: ActiveRoomRun) => {
    activeRunsRef.current[agentId] = run;
    setRunningAgentRequestIds((current) => ({
      ...current,
      [agentId]: run.requestId,
    }));
  }, [activeRunsRef, setRunningAgentRequestIds]);

  const finishAgentRun = useCallback(
    (agentId: RoomAgentId, requestId: string) => {
      if (!isCurrentAgentRun(agentId, requestId)) {
        return;
      }

      delete activeRunsRef.current[agentId];
      setRunningAgentRequestIds((current) => {
        const nextState = { ...current };
        delete nextState[agentId];
        return nextState;
      });
    },
    [activeRunsRef, setRunningAgentRequestIds, isCurrentAgentRun],
  );

  const clearAllActiveRuns = useCallback((reason?: string) => {
    Object.values(activeRunsRef.current).forEach((run) => run.controller.abort(reason ? new Error(reason) : undefined));
    activeRunsRef.current = {};
    setRunningAgentRequestIds({});
  }, [activeRunsRef, setRunningAgentRequestIds]);

  useEffect(
    () => () => {
      Object.values(activeRunsRef.current).forEach((run) => run.controller.abort());
      activeRunsRef.current = {};
    },
    [activeRunsRef],
  );

  const readRoomStream = useCallback(
    async (
      response: Response,
      initiatingRoomId: string,
      agentId: RoomAgentId,
      turnId: string,
      requestId: string,
    ): Promise<{
      emittedMessages: RoomMessage[];
      receiptUpdates: RoomMessageReceiptUpdate[];
    }> => {
      return processRoomStream({
        response,
        shouldContinue: () => isCurrentAgentRun(agentId, requestId),
        onTextDelta: (delta) => {
          updateAgentTurns(agentId, (turns) =>
            updateTurn(turns, turnId, (turn) => ({
              ...turn,
              assistantContent: `${turn.assistantContent}${delta}`,
            })),
          );
        },
        onTool: (tool) => {
          updateAgentTurns(agentId, (turns) =>
            updateTurn(turns, turnId, (turn) => ({
              ...turn,
              tools: [...turn.tools, tool],
            })),
          );
          if (tool.roomAction && tool.roomAction.type !== "read_no_reply") {
            applyRoomToolActions([tool.roomAction], agentId);
          }
        },
        onRoomMessage: (message) => {
          updateRoomState(message.roomId, (room) => appendMessageToRoom(room, message));
          maybeStartSchedulerForRoomMessage(message.roomId, message);

          updateAgentTurns(agentId, (turns) =>
            updateTurn(turns, turnId, (turn) => ({
              ...turn,
              emittedMessages: [...turn.emittedMessages, message],
            })),
          );
        },
        onReceiptUpdate: (update) => {
          updateRoomState(update.roomId, (room) => {
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
          applyReceiptUpdateToAllAgentConsoles(update);
        },
        onDone: (event) => {
          updateRoomState(initiatingRoomId, (room) => ({
            ...room,
            roomMessages: room.roomMessages.map((message) =>
              message.id === event.turn.userMessage.id ? event.turn.userMessage : message,
            ),
            error: "",
            updatedAt: createTimestamp(),
          }));

          updateAgentTurns(agentId, (turns) =>
            updateTurn(turns, turnId, (turn) => ({
              ...event.turn,
              id: turnId,
              ...(turn.continuationSnapshot ? { continuationSnapshot: turn.continuationSnapshot } : {}),
            })),
          );

          updateAgentState(agentId, (state) => ({
            ...state,
            resolvedModel: event.resolvedModel,
            compatibility: event.compatibility,
            updatedAt: createTimestamp(),
          }));
        },
        onMeta: (meta) => {
          const normalizedMeta = normalizeAssistantMeta(meta);
          if (!normalizedMeta) {
            return;
          }

          updateAgentTurns(agentId, (turns) =>
            updateTurn(turns, turnId, (turn) => ({
              ...turn,
              meta: normalizedMeta,
            })),
          );
        },
      });
    },
    [
      applyReceiptUpdateToAllAgentConsoles,
      applyRoomToolActions,
      isCurrentAgentRun,
      maybeStartSchedulerForRoomMessage,
      normalizeAssistantMeta,
      updateAgentState,
      updateAgentTurns,
      updateRoomState,
    ],
  );

  const executeAgentTurn = useCallback(
    async (params: {
      roomId: string;
      agentId: RoomAgentId;
      inputMessage: RoomMessage;
      runRequestId?: string;
    }): Promise<ExecuteAgentTurnResult> => {
      const roomSnapshot = roomsRef.current.find((room) => room.id === params.roomId);
      if (!roomSnapshot) {
        return { status: "aborted", emittedMessages: [], receiptUpdates: [] };
      }

      const roomTitle = roomSnapshot.title;
      const agent = getRoomAgent(params.agentId);
      const previousActiveRun = getActiveAgentRun(agent.id);
      const pendingTurn: AgentRoomTurn = {
        id: createUuid(),
        agent: {
          id: agent.id,
          label: agent.label,
        },
        userMessage: params.inputMessage,
        assistantContent: "",
        tools: [],
        emittedMessages: [],
        status: "running",
      };
      const requestId = params.runRequestId ?? createUuid();
      const controller = new AbortController();
      let emittedMessages: RoomMessage[] = [];
      let receiptUpdates: RoomMessageReceiptUpdate[] = [];

      if (previousActiveRun) {
        updateAgentTurns(agent.id, (turns) =>
          updateTurn(turns, previousActiveRun.turnId, (turn) =>
            turn.status === "running"
              ? {
                  ...turn,
                  status: "continued",
                }
              : turn,
          ),
        );
      }

      updateAgentTurns(agent.id, (turns) => mergeAgentTurns(turns, [pendingTurn]));
      startAgentRun(agent.id, {
        roomId: params.roomId,
        requestId,
        turnId: pendingTurn.id,
        controller,
      });
      previousActiveRun?.controller.abort();

      try {
        const response = await fetch("/api/room-chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({
            message: {
              id: params.inputMessage.id,
              content: params.inputMessage.content,
              sender: params.inputMessage.sender,
            },
            settings: (agentStatesRef.current[agent.id] ?? createAgentSharedState()).settings,
            room: {
              id: params.roomId,
              title: roomTitle,
            },
            attachedRooms: getAttachedRoomsForAgent(agent.id, params.roomId, roomTitle),
            knownAgents: getKnownAgentsForToolContext(),
            roomHistoryById: getRoomHistoryByIdForAgent(agent.id),
            agent: {
              id: agent.id,
              label: agent.label,
              instruction: agent.instruction,
            },
            stream: true,
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error || "The server returned an unknown room error.");
        }

        if (!isCurrentAgentRun(agent.id, requestId)) {
          return { status: "superseded", emittedMessages, receiptUpdates };
        }

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const payload = (await response.json()) as RoomChatResponseBody;
          if (!isCurrentAgentRun(agent.id, requestId)) {
            return { status: "superseded", emittedMessages, receiptUpdates };
          }

          emittedMessages = payload.emittedMessages;
          receiptUpdates = payload.receiptUpdates ?? [];
          applyRoomToolActions(
            payload.turn.tools.flatMap((tool) => (tool.roomAction && tool.roomAction.type !== "read_no_reply" ? [tool.roomAction] : [])),
            agent.id,
          );

          updateRoomState(params.roomId, (room) => {
            let nextRoom = {
              ...room,
              roomMessages: room.roomMessages.map((message) =>
                message.id === payload.turn.userMessage.id
                  ? {
                      ...payload.turn.userMessage,
                      seq: room.roomMessages.find((entry) => entry.id === payload.turn.userMessage.id)?.seq ?? payload.turn.userMessage.seq,
                    }
                  : message,
              ),
              error: "",
              updatedAt: createTimestamp(),
            };

            for (const receiptUpdate of receiptUpdates) {
              const nextMessages = applyMessageReceiptUpdate(nextRoom.roomMessages, receiptUpdate);
              if (nextMessages !== nextRoom.roomMessages) {
                nextRoom = {
                  ...nextRoom,
                  roomMessages: nextMessages,
                  receiptRevision: nextRoom.receiptRevision + 1,
                };
              }
            }

            for (const emittedMessage of emittedMessages) {
              nextRoom = appendMessageToRoom(nextRoom, emittedMessage);
            }

            return nextRoom;
          });

          for (const emittedMessage of emittedMessages) {
            maybeStartSchedulerForRoomMessage(emittedMessage.roomId, emittedMessage);
          }
          for (const receiptUpdate of receiptUpdates) {
            applyReceiptUpdateToAllAgentConsoles(receiptUpdate);
          }

          updateAgentTurns(agent.id, (turns) =>
            updateTurn(turns, pendingTurn.id, (turn) => ({
              ...payload.turn,
              id: pendingTurn.id,
              ...(turn.continuationSnapshot ? { continuationSnapshot: turn.continuationSnapshot } : {}),
            })),
          );

          updateAgentState(agent.id, (state) => ({
            ...state,
            resolvedModel: payload.resolvedModel,
            compatibility: payload.compatibility,
            updatedAt: createTimestamp(),
          }));
        } else {
          const streamResult = await readRoomStream(response, params.roomId, agent.id, pendingTurn.id, requestId);
          emittedMessages = streamResult.emittedMessages;
          receiptUpdates = streamResult.receiptUpdates;
          if (!isCurrentAgentRun(agent.id, requestId)) {
            return { status: "superseded", emittedMessages, receiptUpdates };
          }
        }

        return { status: "completed", emittedMessages, receiptUpdates };
      } catch (caughtError) {
        if (!isCurrentAgentRun(agent.id, requestId)) {
          return { status: "superseded", emittedMessages, receiptUpdates };
        }

        if (controller.signal.aborted) {
          return { status: "aborted", emittedMessages, receiptUpdates };
        }

        const message = caughtError instanceof Error ? caughtError.message : "Unknown request failure.";
        updateRoomState(params.roomId, (room) => ({
          ...room,
          error: message,
          updatedAt: createTimestamp(),
        }));
        updateAgentTurns(agent.id, (turns) =>
          updateTurn(turns, pendingTurn.id, (turn) => ({
            ...turn,
            status: "error",
            error: message,
          })),
        );
        return { status: "error", emittedMessages, receiptUpdates };
      } finally {
        finishAgentRun(agent.id, requestId);
        const schedulerRun = activeSchedulerRunsRef.current[params.roomId];
        if (schedulerRun?.activeRequestId === requestId) {
          activeSchedulerRunsRef.current[params.roomId] = {
            ...schedulerRun,
            activeAgentId: null,
            activeRequestId: null,
          };
        }
      }
    },
    [
      activeSchedulerRunsRef,
      agentStatesRef,
      applyReceiptUpdateToAllAgentConsoles,
      applyRoomToolActions,
      finishAgentRun,
      getActiveAgentRun,
      getAttachedRoomsForAgent,
      getKnownAgentsForToolContext,
      getRoomHistoryByIdForAgent,
      isCurrentAgentRun,
      maybeStartSchedulerForRoomMessage,
      mergeAgentTurns,
      readRoomStream,
      roomsRef,
      startAgentRun,
      updateAgentState,
      updateAgentTurns,
      updateRoomState,
    ],
  );

  return {
    executeAgentTurn,
    getActiveAgentRun,
    isCurrentAgentRun,
    clearAllActiveRuns,
  };
}
