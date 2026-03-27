import { MAX_MESSAGE_IMAGE_ATTACHMENTS } from "@/lib/chat/message-attachments";
import type { ExternalInboundMessageType } from "@/lib/server/channels/types";

export interface ParsedFeishuMessageContent {
  text: string;
  imageKeys: string[];
  fileKey: string | null;
  fileName: string | null;
  placeholderText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeImageKey(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized || null;
}

function appendUnique(target: string[], value: string | null): void {
  if (!value || target.includes(value)) {
    return;
  }
  target.push(value);
}

function parseRawJson(rawContent: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawContent) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectPostSegments(value: unknown, textSegments: string[], imageKeys: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPostSegments(item, textSegments, imageKeys);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const tag = normalizeString(value.tag);
  if (tag === "text") {
    const text = normalizeString(value.text);
    if (text) {
      textSegments.push(text);
    }
    return;
  }

  if (tag === "img") {
    appendUnique(imageKeys, normalizeImageKey(value.image_key));
    return;
  }

  const title = normalizeString(value.title);
  if (title) {
    textSegments.push(title);
  }

  for (const child of Object.values(value)) {
    collectPostSegments(child, textSegments, imageKeys);
  }
}

function createPlaceholderText(messageType: ExternalInboundMessageType, fileName: string | null): string {
  switch (messageType) {
    case "image":
      return "[Feishu image message]";
    case "file":
      return fileName ? `[Feishu file message: ${fileName}]` : "[Feishu file message]";
    case "audio":
      return "[Feishu audio message]";
    case "video":
      return "[Feishu video message]";
    case "sticker":
      return "[Feishu sticker message]";
    case "post":
      return "[Feishu rich text message]";
    default:
      return "[Unsupported Feishu message]";
  }
}

export function parseFeishuMessageContent(messageType: ExternalInboundMessageType, rawContent: string | undefined): ParsedFeishuMessageContent {
  const raw = rawContent?.trim() || "";
  if (!raw) {
    return {
      text: "",
      imageKeys: [],
      fileKey: null,
      fileName: null,
      placeholderText: createPlaceholderText(messageType, null),
    };
  }

  if (messageType === "text") {
    const parsed = parseRawJson(raw);
    const text = parsed ? normalizeString(parsed.text) : raw;
    return {
      text,
      imageKeys: [],
      fileKey: null,
      fileName: null,
      placeholderText: "",
    };
  }

  const parsed = parseRawJson(raw);
  if (!parsed) {
    return {
      text: "",
      imageKeys: [],
      fileKey: null,
      fileName: null,
      placeholderText: createPlaceholderText(messageType, null),
    };
  }

  if (messageType === "image") {
    const imageKey = normalizeImageKey(parsed.image_key);
    return {
      text: "",
      imageKeys: imageKey ? [imageKey] : [],
      fileKey: imageKey,
      fileName: normalizeString(parsed.file_name) || null,
      placeholderText: createPlaceholderText(messageType, null),
    };
  }

  if (messageType === "post") {
    const textSegments: string[] = [];
    const imageKeys: string[] = [];
    collectPostSegments(parsed, textSegments, imageKeys);
    return {
      text: textSegments.join("\n").trim(),
      imageKeys: imageKeys.slice(0, MAX_MESSAGE_IMAGE_ATTACHMENTS),
      fileKey: null,
      fileName: null,
      placeholderText: createPlaceholderText(messageType, null),
    };
  }

  const fileName = normalizeString(parsed.file_name) || null;
  const fileKey = normalizeImageKey(parsed.file_key) || normalizeImageKey(parsed.image_key);
  return {
    text: "",
    imageKeys: [],
    fileKey,
    fileName,
    placeholderText: createPlaceholderText(messageType, fileName),
  };
}
