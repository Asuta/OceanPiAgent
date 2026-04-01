import type { RoomMessagePreviewEmission } from "@/lib/chat/types";

interface ToolCallPreviewSource {
  id: string;
  name: string;
  arguments: unknown;
  partialJson?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractJsonStringField(source: string, key: string): string | null {
  const keyIndex = source.indexOf(`"${key}"`);
  if (keyIndex < 0) {
    return null;
  }

  const colonIndex = source.indexOf(":", keyIndex + key.length + 2);
  if (colonIndex < 0) {
    return null;
  }

  let valueStart = colonIndex + 1;
  while (valueStart < source.length && /\s/.test(source[valueStart] ?? "")) {
    valueStart += 1;
  }

  if (source[valueStart] !== '"') {
    return null;
  }

  let cursor = valueStart + 1;
  let escaped = false;
  let rawValue = "";
  while (cursor < source.length) {
    const character = source[cursor] ?? "";
    if (escaped) {
      rawValue += `\\${character}`;
      escaped = false;
      cursor += 1;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      cursor += 1;
      continue;
    }
    if (character === '"') {
      try {
        return JSON.parse(`"${rawValue}"`) as string;
      } catch {
        return rawValue;
      }
    }
    rawValue += character;
    cursor += 1;
  }

  // Allow previews from partial JSON chunks while the content string is still streaming.
  try {
    return JSON.parse(`"${rawValue}"`) as string;
  } catch {
    return rawValue.replace(/\\(["\\/bfnrt])/g, "$1");
  }
}

function extractJsonBooleanField(source: string, key: string): boolean | null {
  const match = source.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`));
  if (!match) {
    return null;
  }
  return match[1] === "true";
}

function normalizePreviewArgs(args: unknown): Record<string, unknown> | null {
  if (isRecord(args)) {
    return args;
  }

  if (typeof args !== "string") {
    return null;
  }

  const trimmed = args.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    const roomId = extractJsonStringField(trimmed, "roomId");
    const content = extractJsonStringField(trimmed, "content");
    if (!roomId || content === null) {
      return null;
    }

    const messageKey = extractJsonStringField(trimmed, "messageKey");
    const kind = extractJsonStringField(trimmed, "kind");
    const status = extractJsonStringField(trimmed, "status");
    const final = extractJsonBooleanField(trimmed, "final");

    return {
      roomId,
      ...(messageKey ? { messageKey } : {}),
      content,
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
      ...(final === null ? {} : { final }),
    };
  }
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
  const normalizedArgs = normalizePreviewArgs(args);
  if (toolName !== "send_message_to_room" || !normalizedArgs) {
    return null;
  }

  const roomId = typeof normalizedArgs.roomId === "string" ? normalizedArgs.roomId.trim() : "";
  if (!roomId) {
    return null;
  }

  if (typeof normalizedArgs.content !== "string") {
    return null;
  }

  return {
    toolCallId,
    roomId,
    ...(typeof normalizedArgs.messageKey === "string" && normalizedArgs.messageKey.trim()
      ? {
          messageKey: normalizedArgs.messageKey.trim(),
        }
      : {}),
    content: normalizedArgs.content,
    kind: isRoomMessageKind(normalizedArgs.kind) ? normalizedArgs.kind : "answer",
    status: isRoomMessageStatus(normalizedArgs.status) ? normalizedArgs.status : "streaming",
    final: typeof normalizedArgs.final === "boolean" ? normalizedArgs.final : false,
  };
}

export function extractRoomMessagePreviewFromToolCallBlock(block: ToolCallPreviewSource): RoomMessagePreviewEmission | null {
  const previewArgs = typeof block.partialJson === "string" && block.partialJson.trim() ? block.partialJson : block.arguments;
  return extractRoomMessagePreviewFromToolArgs(block.id, block.name, previewArgs);
}
