import { NextResponse } from "next/server";
import { z } from "zod";
import {
  DEFAULT_MAX_TOOL_LOOP_STEPS,
  MAX_MAX_TOOL_LOOP_STEPS,
  MIN_MAX_TOOL_LOOP_STEPS,
  THINKING_LEVELS,
  type AgentInfoCard,
  type AttachedRoomDefinition,
  type RoomChatStreamEvent,
  type RoomHistoryMessageSummary,
} from "@/lib/chat/types";
import {
  extractAssistantMetaFromRoomTurnError,
  runPreparedRoomTurn,
  type RunPreparedRoomTurnInput,
} from "@/lib/server/room-runner";

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

function encodeSseEvent(event: RoomChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function toPreparedInput(payload: {
  message: RunPreparedRoomTurnInput["message"];
  settings: RunPreparedRoomTurnInput["settings"];
  room: RunPreparedRoomTurnInput["room"];
  attachedRooms: AttachedRoomDefinition[];
  knownAgents: AgentInfoCard[];
  roomHistoryById: Record<string, RoomHistoryMessageSummary[]>;
  agent: RunPreparedRoomTurnInput["agent"];
  signal?: AbortSignal;
}): RunPreparedRoomTurnInput {
  return {
    message: payload.message,
    settings: payload.settings,
    room: payload.room,
    attachedRooms: payload.attachedRooms,
    knownAgents: payload.knownAgents,
    roomHistoryById: payload.roomHistoryById,
    agent: payload.agent,
    signal: payload.signal,
  };
}

export async function POST(request: Request) {
  try {
    const payload = requestSchema.parse(await request.json());
    const preparedInput = toPreparedInput({
      ...payload,
      signal: request.signal,
    });

    if (!payload.stream) {
      const result = await runPreparedRoomTurn(preparedInput);
      return NextResponse.json(result);
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          try {
            const result = await runPreparedRoomTurn(preparedInput, {
              onTextDelta: (delta) => {
                controller.enqueue(
                  encodeSseEvent({
                    type: "agent-text-delta",
                    delta,
                  }),
                );
              },
              onTool: (tool) => {
                controller.enqueue(
                  encodeSseEvent({
                    type: "tool",
                    tool,
                  }),
                );
              },
              onRoomMessage: (message) => {
                controller.enqueue(
                  encodeSseEvent({
                    type: "room-message",
                    message,
                  }),
                );
              },
              onReceiptUpdate: (update) => {
                controller.enqueue(
                  encodeSseEvent({
                    type: "message-receipt",
                    update,
                  }),
                );
              },
            });

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
