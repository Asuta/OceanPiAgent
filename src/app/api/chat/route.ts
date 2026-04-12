import { NextResponse } from "next/server";
import { z } from "zod";
import { MEMORY_BACKENDS } from "@/lib/chat/types";
import { extractAssistantMetaFromConversationError, runConversation, streamConversation } from "@/lib/ai/openai-client";
import { assistantMessageMetaSchema, messageImageAttachmentSchema } from "@/lib/chat/schemas";
import {
  DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  DEFAULT_MAX_TOOL_LOOP_STEPS,
  MAX_COMPACTION_TOKEN_THRESHOLD,
  MAX_MAX_TOOL_LOOP_STEPS,
  MIN_COMPACTION_TOKEN_THRESHOLD,
  MIN_MAX_TOOL_LOOP_STEPS,
  THINKING_LEVELS,
} from "@/lib/chat/types";
import type { ChatResponseBody, ChatStreamEvent } from "@/lib/chat/types";
import { resolveSettingsWithModelConfig } from "@/lib/server/model-config-store";
import { createUuid } from "@/lib/utils/uuid";

export const runtime = "nodejs";

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        id: z.string().optional(),
        role: z.enum(["user", "assistant"]),
        content: z.string().max(20_000),
        attachments: z.array(messageImageAttachmentSchema).max(3).optional().default([]),
        meta: assistantMessageMetaSchema.optional(),
      }).superRefine((message, ctx) => {
        if (!message.content.trim() && message.attachments.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Message content or at least one image is required.",
            path: ["content"],
          });
        }
      }),
    )
    .min(1),
  settings: z.object({
    modelConfigId: z.string().max(120).nullable().optional().default(null),
    apiFormat: z.enum(["chat_completions", "responses"]),
    model: z.string().max(200).optional().default(""),
    systemPrompt: z.string().max(4_000).optional().default(""),
    providerMode: z.enum(["auto", "openai", "right_codes", "generic"]).optional().default("auto"),
    memoryBackend: z.enum(MEMORY_BACKENDS).optional().default("sqlite-fts"),
    compactionTokenThreshold: z.number().int().min(MIN_COMPACTION_TOKEN_THRESHOLD).max(MAX_COMPACTION_TOKEN_THRESHOLD).optional().default(DEFAULT_COMPACTION_TOKEN_THRESHOLD),
    thinkingLevel: z.preprocess((value) => (value === "minimal" ? "none" : value), z.enum(THINKING_LEVELS)).optional().default("off"),
    enabledSkillIds: z.array(z.string().trim().min(1).max(120)).max(24).optional().default([]),
    maxToolLoopSteps: z
      .number()
      .int()
      .min(MIN_MAX_TOOL_LOOP_STEPS)
      .max(MAX_MAX_TOOL_LOOP_STEPS)
      .optional()
      .default(DEFAULT_MAX_TOOL_LOOP_STEPS),
  }),
  stream: z.boolean().optional().default(false),
});

function toAssistantResponse(
  result: Awaited<ReturnType<typeof runConversation>>,
): ChatResponseBody {
  return {
      message: {
        id: createUuid(),
        role: "assistant",
        content: result.assistantText,
        attachments: [],
        tools: result.toolEvents,
        meta: {
          apiFormat: result.actualApiFormat,
          compatibility: result.compatibility,
          ...(result.responseId ? { responseId: result.responseId } : {}),
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          ...(result.continuation ? { continuation: result.continuation } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.historyDelta ? { historyDelta: result.historyDelta } : {}),
          ...(result.recovery ? { recovery: result.recovery } : {}),
          ...(result.emptyCompletion ? { emptyCompletion: result.emptyCompletion } : {}),
        },
    },
    resolvedModel: result.resolvedModel,
    compatibility: result.compatibility,
  };
}

function encodeSseEvent(event: ChatStreamEvent): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request) {
  try {
    const payload = requestSchema.parse(await request.json());
    const resolvedSelection = await resolveSettingsWithModelConfig(payload.settings);

    if (!payload.stream) {
      const result = await runConversation(payload.messages, resolvedSelection.settings, {
        modelConfigOverrides: resolvedSelection.modelConfigOverrides,
        signal: request.signal,
      });
      return NextResponse.json(toAssistantResponse(result));
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          let assistantText = "";
          const toolEvents: Awaited<ReturnType<typeof runConversation>>["toolEvents"] = [];

          try {
            const result = await streamConversation(
              payload.messages,
              resolvedSelection.settings,
              {
                onTextDelta: (delta) => {
                  assistantText += delta;
                  controller.enqueue(
                    encodeSseEvent({
                      type: "text-delta",
                      delta,
                    }),
                  );
                },
                onTool: (tool) => {
                  toolEvents.push(tool);
                  controller.enqueue(
                    encodeSseEvent({
                      type: "tool",
                      tool,
                    }),
                  );
                },
              },
              {
                modelConfigOverrides: resolvedSelection.modelConfigOverrides,
                signal: request.signal,
              },
            );

            controller.enqueue(
              encodeSseEvent({
                type: "done",
                message: {
                  id: createUuid(),
                  role: "assistant",
                  content: result.assistantText || assistantText,
                  attachments: [],
                  tools: toolEvents,
                  meta: {
                    apiFormat: result.actualApiFormat,
                    compatibility: result.compatibility,
                    ...(result.responseId ? { responseId: result.responseId } : {}),
                    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
                    ...(result.continuation ? { continuation: result.continuation } : {}),
                    ...(result.usage ? { usage: result.usage } : {}),
                    ...(result.historyDelta ? { historyDelta: result.historyDelta } : {}),
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
                },
                resolvedModel: result.resolvedModel,
                compatibility: result.compatibility,
              }),
            );
          } catch (error) {
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
