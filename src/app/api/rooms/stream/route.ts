import { NextResponse } from "next/server";
import { z } from "zod";
import type { AgentRoomTurn, RoomChatStreamEvent, RoomSession, RoomWorkspaceState } from "@/lib/chat/types";
import { messageImageAttachmentSchema } from "@/lib/chat/schemas";
import { createSchedulerPacket, getNextAgentParticipant, getSchedulerVisibleTargetMessages } from "@/lib/chat/room-scheduler";
import { createAgentSharedState, createTimestamp, getEnabledAgentParticipants, sortRoomsByUpdatedAt } from "@/lib/chat/workspace-domain";
import { ensureChannelRuntimeStarted } from "@/lib/server/channel-runtime";
import { ensureCronDispatcherStarted } from "@/lib/server/cron-dispatcher";
import { resolveSettingsWithModelConfig } from "@/lib/server/model-config-store";
import {
  buildPreparedInputFromWorkspace,
  extractAssistantMetaFromRoomTurnError,
  runPreparedRoomTurn,
} from "@/lib/server/room-runner";
import { appendUserRoomMessage } from "@/lib/server/room-service";
import { enqueueRoomScheduler } from "@/lib/server/room-scheduler";
import { applyRoomTurnToWorkspace } from "@/lib/server/workspace-state";
import { loadWorkspaceEnvelope, mutateWorkspace } from "@/lib/server/workspace-store";
import { createUuid } from "@/lib/utils/uuid";

export const runtime = "nodejs";

const requestSchema = z.object({
  roomId: z.string().trim().min(1).max(120),
  content: z.string().max(20_000),
  attachments: z.array(messageImageAttachmentSchema).max(3).optional().default([]),
  senderId: z.string().trim().min(1).max(120).optional(),
});

function encodeSseEvent(event: RoomChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
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

function collectAdditionalRoomIds(messages: RoomSession["roomMessages"], targetRoomId: string): string[] {
  return [...new Set(messages.map((message) => message.roomId).filter((roomId) => roomId && roomId !== targetRoomId))];
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

export async function POST(request: Request) {
  try {
    ensureCronDispatcherStarted();
    ensureChannelRuntimeStarted();
    const payload = requestSchema.parse(await request.json());

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          try {
            const appended = await appendUserRoomMessage({
              roomId: payload.roomId,
              content: payload.content,
              attachments: payload.attachments,
              senderId: payload.senderId,
            });

            controller.enqueue(
              encodeSseEvent({
                type: "room-message",
                message: appended.userMessage,
              }),
            );

            const room = appended.room;
            const nextParticipant = getNextAgentParticipant(room);
            const enabledAgents = getEnabledAgentParticipants(room);
            if (!nextParticipant || enabledAgents.length === 0 || room.archivedAt) {
              controller.close();
              return;
            }

            const nextAfterParticipant = getNextAgentParticipant(room, nextParticipant.id);
            const cutoffSeq = room.roomMessages[room.roomMessages.length - 1]?.seq ?? 0;
            const lastCursor = room.scheduler.agentCursorByParticipantId[nextParticipant.id] ?? 0;
            const unseenMessages = room.roomMessages.filter(
              (message) => message.seq > lastCursor && message.seq <= cutoffSeq && message.sender.id !== nextParticipant.id,
            );
            const visibleTargetMessages = getSchedulerVisibleTargetMessages(unseenMessages, nextParticipant);
            if (visibleTargetMessages.length === 0) {
              await mutateWorkspace((workspace) =>
                updateRoom(workspace, payload.roomId, (currentRoom) => ({
                  ...withIdleScheduler(currentRoom),
                  scheduler: {
                    ...currentRoom.scheduler,
                    agentCursorByParticipantId: {
                      ...currentRoom.scheduler.agentCursorByParticipantId,
                      [nextParticipant.id]: cutoffSeq,
                    },
                    agentReceiptRevisionByParticipantId: {
                      ...currentRoom.scheduler.agentReceiptRevisionByParticipantId,
                      [nextParticipant.id]: currentRoom.receiptRevision,
                    },
                  },
                })),
              );
              controller.close();
              return;
            }

            await mutateWorkspace((workspace) =>
              updateRoom(workspace, payload.roomId, (currentRoom) => ({
                ...currentRoom,
                scheduler: {
                  ...currentRoom.scheduler,
                  status: "running",
                  activeParticipantId: nextParticipant.id,
                  nextAgentParticipantId: nextAfterParticipant?.id ?? nextParticipant.id,
                  roundCount: 1,
                },
                error: "",
                updatedAt: createTimestamp(),
              })),
            );

            const targetAgentId = nextParticipant.agentId ?? room.agentId;
            const resolvedSelection = await resolveSettingsWithModelConfig(
              appended.envelope.state.agentStates[targetAgentId]?.settings ?? createAgentSharedState().settings,
            );
            const turnId = `stream:${createUuid()}`;
            const schedulerPacket = createSchedulerPacket({
              room,
              participant: nextParticipant,
              messages: unseenMessages,
              requestId: createUuid(),
              hasNewDelta: unseenMessages.length > 0,
            });

            controller.enqueue(
              encodeSseEvent({
                type: "turn-start",
                turn: createPendingTurn({
                  turnId,
                  agentId: targetAgentId,
                  agentLabel: nextParticipant.name,
                  schedulerPacket,
                  anchorMessageId: visibleTargetMessages[visibleTargetMessages.length - 1]?.id,
                }),
              }),
            );

            const preparedInput = await buildPreparedInputFromWorkspace({
              workspace: appended.envelope.state,
              roomId: payload.roomId,
              agentId: targetAgentId,
              turnId,
              message: schedulerPacket,
              anchorMessageId: visibleTargetMessages[visibleTargetMessages.length - 1]?.id,
              settings: resolvedSelection.settings,
              signal: request.signal,
            });
            preparedInput.modelConfigOverrides = resolvedSelection.modelConfigOverrides;

            const result = await runPreparedRoomTurn(preparedInput, {
              onTextDelta: (delta) => {
                controller.enqueue(encodeSseEvent({ type: "agent-text-delta", delta }));
              },
              onTool: (tool) => {
                controller.enqueue(encodeSseEvent({ type: "tool", tool }));
              },
              onRoomMessagePreview: (message) => {
                controller.enqueue(encodeSseEvent({ type: "room-message-preview", message }));
              },
              onRoomMessage: (message) => {
                controller.enqueue(encodeSseEvent({ type: "room-message", message }));
              },
              onReceiptUpdate: (update) => {
                controller.enqueue(encodeSseEvent({ type: "message-receipt", update }));
              },
            });

            const latestWorkspace = await loadWorkspaceEnvelope();
            const latestRoom = latestWorkspace.state.rooms.find((entry) => entry.id === payload.roomId);
            const wasSuperseded = latestRoom ? hasNewerVisibleActivity(latestRoom, nextParticipant.id, cutoffSeq) : false;

            if (!wasSuperseded) {
              await mutateWorkspace((workspace) => {
                const appliedWorkspace = applyRoomTurnToWorkspace({
                  workspace,
                  agentId: targetAgentId,
                  targetRoomId: payload.roomId,
                  turn: result.turn,
                  resolvedModel: result.resolvedModel,
                  compatibility: result.compatibility,
                  emittedMessages: result.emittedMessages,
                  receiptUpdates: result.receiptUpdates,
                  roomActions: result.roomActions,
                });

                return updateRoom(appliedWorkspace, payload.roomId, (currentRoom) => ({
                  ...currentRoom,
                  scheduler: {
                    ...currentRoom.scheduler,
                    status: result.turn.status === "completed" ? "running" : "idle",
                    activeParticipantId: null,
                    nextAgentParticipantId: nextAfterParticipant?.id ?? nextParticipant.id,
                    roundCount: result.turn.status === "completed" ? 1 : 0,
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
            }

            if (result.turn.status === "completed") {
              void enqueueRoomScheduler(payload.roomId);
            }
            for (const additionalRoomId of collectAdditionalRoomIds(result.emittedMessages, payload.roomId)) {
              void enqueueRoomScheduler(additionalRoomId);
            }

            controller.enqueue(
              encodeSseEvent({
                type: "done",
                turn: result.turn,
                resolvedModel: result.resolvedModel,
                compatibility: result.compatibility,
              }),
            );
          } catch (error) {
            if (request.signal.aborted) {
              controller.close();
              return;
            }

            const message = error instanceof Error ? error.message : "Unknown server error.";
            const meta = extractAssistantMetaFromRoomTurnError(error);
            controller.enqueue(
              encodeSseEvent({
                type: "error",
                error: message,
                ...(meta ? { meta } : {}),
              }),
            );
          } finally {
            controller.close();
          }
        })();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
