import { NextResponse } from "next/server";
import { z } from "zod";
import { extractAssistantMetaFromConversationError, streamConversation } from "@/lib/ai/openai-client";
import { buildRoomBridgePrompt } from "@/lib/ai/system-prompt";
import {
  clearAgentRoomRun,
  completeAgentRoomRun,
  isCurrentAgentRun,
  recordAgentTextDelta,
  recordAgentToolEvent,
  startAgentRoomRun,
} from "@/lib/server/agent-room-sessions";
import {
  DEFAULT_MAX_TOOL_LOOP_STEPS,
  MAX_MAX_TOOL_LOOP_STEPS,
  MIN_MAX_TOOL_LOOP_STEPS,
  THINKING_LEVELS,
} from "@/lib/chat/types";
import type {
  AgentInfoCard,
  AgentRoomTurn,
  AttachedRoomDefinition,
  RoomHistoryMessageSummary,
  RoomChatResponseBody,
  RoomChatStreamEvent,
  RoomMessageEmission,
  RoomMessageReceipt,
  RoomMessageReceiptStatus,
  RoomMessageReceiptUpdate,
  RoomMessage,
  RoomSender,
  RoomToolContext,
  ToolExecution,
} from "@/lib/chat/types";

export const runtime = "nodejs";

const requestSchema = z.object({
  message: z.object({
    id: z.string().max(120),
    content: z.string().trim().min(1).max(20_000),
    sender: z.object({
      id: z.string().trim().min(1).max(120),
      name: z.string().trim().min(1).max(120),
      role: z.enum(["participant", "system"]),
    }),
  }),
  settings: z.object({
    apiFormat: z.enum(["chat_completions", "responses"]),
    model: z.string().max(200).optional().default(""),
    systemPrompt: z.string().max(4_000).optional().default(""),
    providerMode: z.enum(["auto", "openai", "right_codes", "generic"]).optional().default("auto"),
    thinkingLevel: z.enum(THINKING_LEVELS).optional().default("off"),
    enabledSkillIds: z.array(z.string().trim().min(1).max(120)).max(24).optional().default([]),
    maxToolLoopSteps: z
      .number()
      .int()
      .min(MIN_MAX_TOOL_LOOP_STEPS)
      .max(MAX_MAX_TOOL_LOOP_STEPS)
      .optional()
      .default(DEFAULT_MAX_TOOL_LOOP_STEPS),
  }),
  room: z.object({
    id: z.string().max(120),
    title: z.string().trim().min(1).max(120),
  }),
  attachedRooms: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(120),
        title: z.string().trim().min(1).max(120),
        archived: z.boolean().optional().default(false),
        ownerParticipantId: z.string().trim().min(1).max(120).nullable().optional().default(null),
        ownerName: z.string().trim().min(1).max(120).nullable().optional().default(null),
        currentAgentMembershipRole: z.enum(["owner", "member"]).nullable().optional().default(null),
        currentAgentIsOwner: z.boolean().optional().default(false),
        participants: z
          .array(
            z.object({
              participantId: z.string().trim().min(1).max(120),
              name: z.string().trim().min(1).max(120),
              runtimeKind: z.enum(["human", "agent"]),
              membershipRole: z.enum(["owner", "member"]),
              enabled: z.boolean().optional().default(true),
              agentId: z.enum(["concierge", "researcher", "operator"]).optional(),
            }),
          )
          .optional()
          .default([]),
        messageCount: z.number().int().min(0).optional().default(0),
        latestMessageAt: z.string().nullable().optional().default(null),
      }),
    )
    .optional()
    .default([]),
  knownAgents: z
    .array(
      z.object({
        agentId: z.enum(["concierge", "researcher", "operator"]),
        label: z.string().trim().min(1).max(120),
        summary: z.string().trim().min(1).max(500),
        skills: z.array(z.string().trim().min(1).max(120)).max(24).optional().default([]),
        workingStyle: z.string().trim().min(1).max(500),
      }),
    )
    .optional()
    .default([]),
  roomHistoryById: z
    .record(
      z.array(
        z.object({
          messageId: z.string().trim().min(1).max(120),
          seq: z.number().int().min(0),
          senderId: z.string().trim().min(1).max(120),
          senderName: z.string().trim().min(1).max(120),
          senderRole: z.enum(["participant", "system"]),
          role: z.enum(["user", "assistant", "system"]),
          source: z.enum(["user", "agent_emit", "system"]),
          kind: z.enum(["user_input", "answer", "progress", "warning", "error", "clarification", "system"]),
          status: z.enum(["pending", "streaming", "completed", "failed"]),
          final: z.boolean(),
          createdAt: z.string(),
          content: z.string().max(20_000),
          receipts: z
            .array(
              z.object({
                participantId: z.string().trim().min(1).max(120),
                participantName: z.string().trim().min(1).max(120),
                agentId: z.enum(["concierge", "researcher", "operator"]).optional(),
                type: z.literal("read_no_reply"),
                createdAt: z.string(),
              }),
            )
            .optional()
            .default([]),
        }),
      ),
    )
    .optional()
    .default({}),
  agent: z.object({
    id: z.enum(["concierge", "researcher", "operator"]),
    label: z.string().trim().min(1).max(120),
    instruction: z.string().max(4_000).optional().default(""),
  }),
  stream: z.boolean().optional().default(true),
});

function createAgentSender(agent: AgentRoomTurn["agent"]): RoomSender {
  return {
    id: agent.id,
    name: agent.label,
    role: "participant",
  };
}

function sortReceipts(receipts: RoomMessageReceipt[]): RoomMessageReceipt[] {
  return [...receipts].sort((left, right) => {
    const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }

    return left.participantName.localeCompare(right.participantName);
  });
}

function upsertReceipt(receipts: RoomMessageReceipt[], receipt: RoomMessageReceipt): RoomMessageReceipt[] {
  if (receipts.some((entry) => entry.participantId === receipt.participantId)) {
    return receipts;
  }

  const nextReceipts = receipts.filter((entry) => entry.participantId !== receipt.participantId);
  nextReceipts.push(receipt);
  return sortReceipts(nextReceipts);
}

function createReadNoReplyReceipt(agent: AgentRoomTurn["agent"], createdAt: string): RoomMessageReceipt {
  return {
    participantId: agent.id,
    participantName: agent.label,
    agentId: agent.id,
    type: "read_no_reply",
    createdAt,
  };
}

function createRoomMessage(message: RoomMessageEmission, agent: AgentRoomTurn["agent"]): RoomMessage {
  return {
    id: crypto.randomUUID(),
    roomId: message.roomId,
    seq: 0,
    role: "assistant",
    sender: createAgentSender(agent),
    content: message.content,
    source: "agent_emit",
    kind: message.kind,
    status: message.status,
    final: message.final,
    createdAt: new Date().toISOString(),
    receipts: [],
    receiptStatus: "none",
    receiptUpdatedAt: null,
  };
}

function createUserMessage(
  roomId: string,
  messageId: string,
  sender: RoomSender,
  content: string,
  receipts: RoomMessageReceipt[],
  receiptStatus: RoomMessageReceiptStatus,
  receiptUpdatedAt: string | null,
): RoomMessage {
  const normalizedReceipts = sortReceipts(receipts);
  const latestReceipt = normalizedReceipts[normalizedReceipts.length - 1] ?? null;
  return {
    id: messageId,
    roomId,
    seq: 0,
    role: "user",
    sender,
    content,
    source: "user",
    kind: "user_input",
    status: "completed",
    final: true,
    createdAt: new Date().toISOString(),
    receipts: normalizedReceipts,
    receiptStatus: normalizedReceipts.length > 0 ? "read_no_reply" : receiptStatus,
    receiptUpdatedAt: latestReceipt?.createdAt ?? receiptUpdatedAt,
  };
}

function createMessageReceiptUpdate(
  roomId: string,
  messageId: string,
  receipt: RoomMessageReceipt,
): RoomMessageReceiptUpdate {
  return {
    roomId,
    messageId,
    receipt,
    receiptStatus: "read_no_reply",
    receiptUpdatedAt: receipt.createdAt,
  };
}

function createTurn(
  agent: AgentRoomTurn["agent"],
  roomId: string,
  userMessageId: string,
  userSender: RoomSender,
  userContent: string,
  userMessageReceipts: RoomMessageReceipt[],
  userMessageReceiptStatus: RoomMessageReceiptStatus,
  userMessageReceiptUpdatedAt: string | null,
  assistantContent: string,
  tools: ToolExecution[],
  emittedMessages: RoomMessage[],
  meta: AgentRoomTurn["meta"],
  resolvedModel: string,
  status: AgentRoomTurn["status"],
  continuationSnapshot?: string,
  error?: string,
): AgentRoomTurn {
  return {
    id: crypto.randomUUID(),
    agent,
    userMessage: createUserMessage(
      roomId,
      userMessageId,
      userSender,
      userContent,
      userMessageReceipts,
      userMessageReceiptStatus,
      userMessageReceiptUpdatedAt,
    ),
    assistantContent,
    tools,
    emittedMessages,
    status,
    meta,
    resolvedModel,
    ...(continuationSnapshot
      ? {
          continuationSnapshot,
        }
      : {}),
    ...(error
      ? {
          error,
        }
      : {}),
  };
}

function encodeSseEvent(event: RoomChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function createToolContext(payload: {
  room: { id: string };
  agent: { id: AgentRoomTurn["agent"]["id"] };
  attachedRooms: AttachedRoomDefinition[];
  knownAgents: AgentInfoCard[];
  roomHistoryById: Record<string, RoomHistoryMessageSummary[]>;
}): RoomToolContext {
  return {
    currentAgentId: payload.agent.id,
    currentRoomId: payload.room.id,
    attachedRooms: payload.attachedRooms.map((room) => ({
      ...room,
      participants: room.participants.map((participant) => ({
        ...participant,
      })),
    })),
    knownAgents: payload.knownAgents.map((agent) => ({
      ...agent,
      skills: [...agent.skills],
    })),
    roomHistoryById: Object.fromEntries(
      Object.entries(payload.roomHistoryById).map(([roomId, messages]) => [
        roomId,
        messages.map((message) => ({
          ...message,
          receipts: [...message.receipts],
        })),
      ]),
    ),
  };
}

export async function POST(request: Request) {
  try {
    const payload = requestSchema.parse(await request.json());
    const userContent = payload.message.content;
    const userMessageId = payload.message.id;
    const userSender = payload.message.sender;
    const agent = {
      id: payload.agent.id,
      label: payload.agent.label,
    } satisfies AgentRoomTurn["agent"];
    const toolContext = createToolContext(payload);
    const promptOverride = buildRoomBridgePrompt({
      operatorPrompt: payload.settings.systemPrompt,
      roomId: payload.room.id,
      roomTitle: payload.room.title,
      agentLabel: payload.agent.label,
      agentInstruction: payload.agent.instruction,
      attachedRooms: payload.attachedRooms,
    });
    const runContext = await startAgentRoomRun({
      agentId: payload.agent.id,
      roomId: payload.room.id,
      roomTitle: payload.room.title,
      attachedRooms: payload.attachedRooms,
      userMessageId,
      userSender,
      userContent,
      requestSignal: request.signal,
    });

    if (!payload.stream) {
      const toolEvents: ToolExecution[] = [];
      const emittedMessages: RoomMessage[] = [];
      const receiptUpdates: RoomMessageReceiptUpdate[] = [];
      let currentUserReceiptStatus: RoomMessageReceiptStatus = "none";
      let currentUserReceiptUpdatedAt: string | null = null;
      let currentUserReceipts: RoomMessageReceipt[] = [];

      const result = await streamConversation(
        runContext.history,
        payload.settings,
        {
          onTextDelta: (delta) => {
            if (!isCurrentAgentRun(payload.agent.id, runContext.requestId)) {
              return;
            }

            recordAgentTextDelta(payload.agent.id, runContext.requestId, delta);
          },
          onTool: (tool) => {
            if (!isCurrentAgentRun(payload.agent.id, runContext.requestId)) {
              return;
            }

            toolEvents.push(tool);
            recordAgentToolEvent(payload.agent.id, runContext.requestId, tool);
            if (tool.roomMessage) {
              emittedMessages.push(createRoomMessage(tool.roomMessage, agent));
            }
            if (
              tool.roomAction?.type === "read_no_reply" &&
              tool.roomAction.roomId &&
              tool.roomAction.messageId
            ) {
              const receiptUpdatedAt = new Date().toISOString();
              const receipt = createReadNoReplyReceipt(agent, receiptUpdatedAt);
              receiptUpdates.push(createMessageReceiptUpdate(tool.roomAction.roomId, tool.roomAction.messageId, receipt));
              if (tool.roomAction.roomId === payload.room.id && tool.roomAction.messageId === userMessageId) {
                currentUserReceiptStatus = "read_no_reply";
                currentUserReceiptUpdatedAt = receiptUpdatedAt;
                currentUserReceipts = upsertReceipt(currentUserReceipts, receipt);
              }
            }
          },
        },
        {
          toolScope: "room",
          systemPromptOverride: promptOverride,
          signal: runContext.signal,
          toolContext,
        },
      );

      await completeAgentRoomRun({
        agentId: payload.agent.id,
        requestId: runContext.requestId,
        assistantText: result.assistantText,
        resolvedModel: result.resolvedModel,
        compatibility: result.compatibility,
      });

      const responseBody: RoomChatResponseBody = {
        turn: createTurn(
          agent,
          payload.room.id,
          userMessageId,
          userSender,
          userContent,
          currentUserReceipts,
          currentUserReceiptStatus,
          currentUserReceiptUpdatedAt,
          result.assistantText,
          toolEvents.length > 0 ? toolEvents : result.toolEvents,
          emittedMessages,
          {
            apiFormat: result.actualApiFormat,
            compatibility: result.compatibility,
            ...(result.recovery
              ? {
                  recovery: result.recovery,
                }
              : {}),
            ...(result.emptyCompletion
              ? {
                  emptyCompletion: result.emptyCompletion,
                }
              : {}),
          },
          result.resolvedModel,
          "completed",
          runContext.continuationSnapshot,
        ),
        resolvedModel: result.resolvedModel,
        compatibility: result.compatibility,
        emittedMessages,
        receiptUpdates,
      };

      return NextResponse.json(responseBody);
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          let assistantContent = "";
          const toolEvents: ToolExecution[] = [];
          const emittedMessages: RoomMessage[] = [];
          let currentUserReceiptStatus: RoomMessageReceiptStatus = "none";
          let currentUserReceiptUpdatedAt: string | null = null;
          let currentUserReceipts: RoomMessageReceipt[] = [];

          try {
            const result = await streamConversation(
              runContext.history,
              payload.settings,
              {
                onTextDelta: (delta) => {
                  if (!isCurrentAgentRun(payload.agent.id, runContext.requestId)) {
                    return;
                  }

                  assistantContent += delta;
                  recordAgentTextDelta(payload.agent.id, runContext.requestId, delta);
                  controller.enqueue(
                    encodeSseEvent({
                      type: "agent-text-delta",
                      delta,
                    }),
                  );
                },
                onTool: (tool) => {
                  if (!isCurrentAgentRun(payload.agent.id, runContext.requestId)) {
                    return;
                  }

                  toolEvents.push(tool);
                  recordAgentToolEvent(payload.agent.id, runContext.requestId, tool);
                  controller.enqueue(
                    encodeSseEvent({
                      type: "tool",
                      tool,
                    }),
                  );

                  if (tool.roomAction?.type === "read_no_reply") {
                    const receiptUpdatedAt = new Date().toISOString();
                    const receipt = createReadNoReplyReceipt(agent, receiptUpdatedAt);
                    if (tool.roomAction.roomId === payload.room.id && tool.roomAction.messageId === userMessageId) {
                      currentUserReceiptStatus = "read_no_reply";
                      currentUserReceiptUpdatedAt = receiptUpdatedAt;
                      currentUserReceipts = upsertReceipt(currentUserReceipts, receipt);
                    }

                    const receiptUpdate = createMessageReceiptUpdate(tool.roomAction.roomId, tool.roomAction.messageId, receipt);

                    controller.enqueue(
                      encodeSseEvent({
                        type: "message-receipt",
                        update: receiptUpdate,
                      }),
                    );
                  }

                  if (tool.roomMessage) {
                    const roomMessage = createRoomMessage(tool.roomMessage, agent);
                    emittedMessages.push(roomMessage);
                    controller.enqueue(
                      encodeSseEvent({
                        type: "room-message",
                        message: roomMessage,
                      }),
                    );
                  }
                },
              },
              {
                toolScope: "room",
                systemPromptOverride: promptOverride,
                signal: runContext.signal,
                toolContext,
              },
            );

            if (!isCurrentAgentRun(payload.agent.id, runContext.requestId)) {
              return;
            }

            await completeAgentRoomRun({
              agentId: payload.agent.id,
              requestId: runContext.requestId,
              assistantText: result.assistantText || assistantContent,
              resolvedModel: result.resolvedModel,
              compatibility: result.compatibility,
            });

            controller.enqueue(
              encodeSseEvent({
                type: "done",
                turn: createTurn(
                  agent,
                  payload.room.id,
                  userMessageId,
                  userSender,
                  userContent,
                  currentUserReceipts,
                  currentUserReceiptStatus,
                  currentUserReceiptUpdatedAt,
                  result.assistantText || assistantContent,
                  toolEvents.length > 0 ? toolEvents : result.toolEvents,
                  emittedMessages,
                  {
                    apiFormat: result.actualApiFormat,
                    compatibility: result.compatibility,
                    ...(result.recovery
                      ? {
                          recovery: result.recovery,
                        }
                      : {}),
                    ...(result.emptyCompletion
                      ? {
                          emptyCompletion: result.emptyCompletion,
                        }
                      : {}),
                  },
                  result.resolvedModel,
                  "completed",
                  runContext.continuationSnapshot,
                ),
                resolvedModel: result.resolvedModel,
                compatibility: result.compatibility,
              }),
            );
          } catch (error) {
            clearAgentRoomRun(payload.agent.id, runContext.requestId);

            if (runContext.signal.aborted) {
              controller.close();
              return;
            }

            const message = error instanceof Error ? error.message : "Unknown server error.";
            const meta = extractAssistantMetaFromConversationError(error);
            controller.enqueue(
              encodeSseEvent({
                type: "error",
                error: message,
                ...(meta
                  ? {
                      meta,
                    }
                  : {}),
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
