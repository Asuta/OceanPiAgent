import type { RoomMessagePreviewEmission } from "@/lib/chat/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRoomMessageKind(value: unknown): value is RoomMessagePreviewEmission["kind"] {
  return value === "answer" || value === "progress" || value === "warning" || value === "error" || value === "clarification";
}

function isRoomMessageStatus(value: unknown): value is RoomMessagePreviewEmission["status"] {
  return value === "pending" || value === "streaming" || value === "completed" || value === "failed";
}

export function extractRoomMessagePreviewFromToolArgs(
  toolCallId: string,
  toolName: string,
  args: unknown,
): RoomMessagePreviewEmission | null {
  if (toolName !== "send_message_to_room" || !isRecord(args)) {
    return null;
  }

  const roomId = typeof args.roomId === "string" ? args.roomId.trim() : "";
  if (!roomId) {
    return null;
  }

  if (typeof args.content !== "string") {
    return null;
  }

  return {
    toolCallId,
    roomId,
    ...(typeof args.messageKey === "string" && args.messageKey.trim()
      ? {
          messageKey: args.messageKey.trim(),
        }
      : {}),
    content: args.content,
    kind: isRoomMessageKind(args.kind) ? args.kind : "answer",
    status: isRoomMessageStatus(args.status) ? args.status : "streaming",
    final: typeof args.final === "boolean" ? args.final : false,
  };
}
