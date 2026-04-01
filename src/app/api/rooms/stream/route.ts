import { NextResponse } from "next/server";
import { z } from "zod";
import type { RoomChatStreamEvent } from "@/lib/chat/types";
import { messageImageAttachmentSchema } from "@/lib/chat/schemas";
import { ensureChannelRuntimeStarted } from "@/lib/server/channel-runtime";
import { ensureCronDispatcherStarted } from "@/lib/server/cron-dispatcher";
import { claimRoomStream } from "@/lib/server/room-stream-control";
import { appendUserRoomMessage } from "@/lib/server/room-service";
import { enqueueRoomScheduler } from "@/lib/server/room-scheduler";

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

export async function POST(request: Request) {
  try {
    ensureCronDispatcherStarted();
    ensureChannelRuntimeStarted();
    const payload = requestSchema.parse(await request.json());

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          let errorSent = false;
          const claimedStream = claimRoomStream(payload.roomId);
          let streamClosed = false;
          const emitEvent = (event: RoomChatStreamEvent) => {
            if (streamClosed) {
              return;
            }

            controller.enqueue(encodeSseEvent(event));
          };
          request.signal.addEventListener("abort", () => {
            streamClosed = true;
          }, { once: true });

          try {
            const appended = await appendUserRoomMessage({
              roomId: payload.roomId,
              content: payload.content,
              attachments: payload.attachments,
              senderId: payload.senderId,
            });

            emitEvent({
              type: "room-message",
              message: appended.userMessage,
            });

            await enqueueRoomScheduler(payload.roomId, {
              signal: claimedStream.signal,
              onTurnStart: (turn) => {
                emitEvent({ type: "turn-start", turn });
              },
              onTextDelta: (delta) => {
                emitEvent({ type: "agent-text-delta", delta });
              },
              onTool: (tool) => {
                emitEvent({ type: "tool", tool });
              },
              onRoomMessagePreview: (message) => {
                emitEvent({ type: "room-message-preview", message });
              },
              onRoomMessage: (message) => {
                emitEvent({ type: "room-message", message });
              },
              onReceiptUpdate: (update) => {
                emitEvent({ type: "message-receipt", update });
              },
              onTurnDone: (result) => {
                emitEvent({
                  type: "done",
                  turn: result.turn,
                  resolvedModel: result.resolvedModel,
                  compatibility: result.compatibility,
                });
              },
              onError: (error, meta) => {
                errorSent = true;
                const message = error instanceof Error ? error.message : "Unknown server error.";
                emitEvent({
                  type: "error",
                  error: message,
                  ...(meta ? { meta } : {}),
                });
              },
            });
          } catch (error) {
            if (claimedStream.signal.aborted || request.signal.aborted) {
              return;
            }

            if (errorSent) {
              return;
            }

            const message = error instanceof Error ? error.message : "Unknown server error.";
            emitEvent({
              type: "error",
              error: message,
            });
          } finally {
            claimedStream.release();
            if (!streamClosed) {
              controller.close();
            }
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
