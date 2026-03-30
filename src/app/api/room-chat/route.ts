import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MEMORY_BACKENDS,
  DEFAULT_MAX_TOOL_LOOP_STEPS,
  MAX_MAX_TOOL_LOOP_STEPS,
  MIN_MAX_TOOL_LOOP_STEPS,
  THINKING_LEVELS,
  type AgentInfoCard,
  type AttachedRoomDefinition,
  type RoomChatStreamEvent,
} from "@/lib/chat/types";
import { messageImageAttachmentSchema } from "@/lib/chat/schemas";
import {
  buildPreparedInputFromWorkspace,
  extractAssistantMetaFromRoomTurnError,
  runPreparedRoomTurn,
} from "@/lib/server/room-runner";
import { ensureChannelRuntimeStarted } from "@/lib/server/channel-runtime";
import { loadWorkspaceEnvelope } from "@/lib/server/workspace-store";
import { resolveSettingsWithModelConfig } from "@/lib/server/model-config-store";

export const runtime = "nodejs";

const agentIdSchema = z.string().trim().min(1).max(120);

const requestSchema = z.object({
  message: z.object({
    id: z.string().max(120),
    content: z.string().max(20_000),
    attachments: z.array(messageImageAttachmentSchema).max(3).optional().default([]),
    sender: z.object({
      id: z.string().trim().min(1).max(120),
      name: z.string().trim().min(1).max(120),
      role: z.enum(["participant", "system"]),
    }),
  }).superRefine((message, ctx) => {
    if (!message.content.trim() && message.attachments.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Message content or at least one image is required.",
        path: ["content"],
      });
    }
  }),
  settings: z.object({
    modelConfigId: z.string().max(120).nullable().optional().default(null),
    apiFormat: z.enum(["chat_completions", "responses"]),
    model: z.string().max(200).optional().default(""),
    systemPrompt: z.string().max(4_000).optional().default(""),
    providerMode: z.enum(["auto", "openai", "right_codes", "generic"]).optional().default("auto"),
    memoryBackend: z.enum(MEMORY_BACKENDS).optional().default("sqlite-fts"),
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
  roomId: z.string().trim().min(1).max(120).optional(),
  roomId: z.string().trim().min(1).max(120).optional(),
  room: z.object({
    id: z.string().max(120),
  }).optional(),
  anchorMessageId: z.string().trim().min(1).max(120).optional(),
  agentId: agentIdSchema.optional(),
  agent: z.object({
    id: agentIdSchema,
  }).optional(),
  stream: z.boolean().optional().default(true),
});

function encodeSseEvent(event: RoomChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request) {
  try {
    ensureChannelRuntimeStarted();
    const payload = requestSchema.parse(await request.json());
    const roomId = payload.roomId ?? payload.room?.id;
    const agentId = payload.agentId ?? payload.agent?.id;
    if (!roomId || !agentId) {
      throw new Error("roomId and agentId are required.");
    }

    const workspaceEnvelope = await loadWorkspaceEnvelope();
    const persistedSettings = workspaceEnvelope.state.agentStates[agentId]?.settings;
    if (!persistedSettings) {
      throw new Error(`Agent ${agentId} does not have persisted workspace settings.`);
    }

    const resolvedSelection = await resolveSettingsWithModelConfig(persistedSettings);
    const preparedInput = await buildPreparedInputFromWorkspace({
      workspace: workspaceEnvelope.state,
      roomId,
      agentId,
      message: payload.message,
      anchorMessageId: payload.anchorMessageId,
      settings: resolvedSelection.settings,
      signal: request.signal,
    });
    preparedInput.modelConfigOverrides = resolvedSelection.modelConfigOverrides;

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
              onRoomMessagePreview: (message) => {
                controller.enqueue(
                  encodeSseEvent({
                    type: "room-message-preview",
                    message,
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
