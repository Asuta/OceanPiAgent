import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_MESSAGE_IMAGE_ATTACHMENTS } from "@/lib/chat/message-attachments";
import type { MessageImageAttachment } from "@/lib/chat/types";
import { appendFeishuRuntimeLog } from "@/lib/server/channel-runtime-log";
import { type FeishuChannelConfig } from "@/lib/server/channels/feishu/config";
import { getFeishuRestClient } from "@/lib/server/channels/feishu/client";
import { storeImageBufferAsAttachment } from "@/lib/server/image-upload-store";

type FeishuMessageResourceResponse = Awaited<ReturnType<ReturnType<typeof getFeishuRestClient>["im"]["messageResource"]["get"]>>;

function normalizeFileName(value: string | null | undefined, fallbackBase: string): string {
  const trimmed = value?.trim();
  return trimmed || `${fallbackBase}.jpg`;
}

async function readResponseBuffer(response: FeishuMessageResourceResponse): Promise<Buffer> {
  if (typeof response.getReadableStream === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of response.getReadableStream()) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  if (typeof response.writeFile === "function") {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-feishu-media-"));
    const tempPath = path.join(tempDir, "download.bin");
    try {
      await response.writeFile(tempPath);
      return await readFile(tempPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  throw new Error("Unsupported Feishu download response format.");
}

function readHeader(headers: Record<string, unknown> | undefined, target: string): string | null {
  if (!headers) {
    return null;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target.toLowerCase()) {
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim());
      if (typeof first === "string") {
        return first.trim();
      }
    }
  }

  return null;
}

function extractFileNameFromDisposition(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]).trim();
    } catch {
      return utf8Match[1].trim();
    }
  }

  const basicMatch = value.match(/filename="?([^";]+)"?/i);
  return basicMatch?.[1]?.trim() || null;
}

export interface FeishuMediaDependencies {
  getClient?: typeof getFeishuRestClient;
  storeAttachment?: typeof storeImageBufferAsAttachment;
  logger?: (args: {
    level: "info" | "warn" | "error";
    message: string;
    details?: Record<string, string | number | boolean | null | undefined>;
  }) => void;
}

export async function downloadFeishuImageAttachment(args: {
  config: FeishuChannelConfig;
  messageId: string;
  imageKey: string;
  fileName?: string | null;
  deps?: FeishuMediaDependencies;
}): Promise<MessageImageAttachment> {
  const getClient = args.deps?.getClient ?? getFeishuRestClient;
  const storeAttachment = args.deps?.storeAttachment ?? storeImageBufferAsAttachment;
  const logger = args.deps?.logger ?? appendFeishuRuntimeLog;
  const client = getClient(args.config);

  logger({
    level: "info",
    message: "Downloading Feishu image resource",
    details: {
      messageId: args.messageId,
      imageKey: args.imageKey,
    },
  });

  const response = await client.im.messageResource.get({
    path: {
      message_id: args.messageId,
      file_key: args.imageKey,
    },
    params: {
      type: "image",
    },
  });

  const buffer = await readResponseBuffer(response);
  const mimeType = readHeader(response.headers as Record<string, unknown> | undefined, "content-type") || "image/jpeg";
  const disposition = readHeader(response.headers as Record<string, unknown> | undefined, "content-disposition");
  const attachment = await storeAttachment({
    buffer,
    mimeType,
    filename: normalizeFileName(args.fileName || extractFileNameFromDisposition(disposition), `feishu-${args.imageKey}`),
  });

  logger({
    level: "info",
    message: "Stored Feishu image attachment",
    details: {
      messageId: args.messageId,
      imageKey: args.imageKey,
      storagePath: attachment.storagePath,
      sizeBytes: attachment.sizeBytes,
      mimeType: attachment.mimeType,
    },
  });

  return attachment;
}

export async function resolveFeishuImageAttachments(args: {
  config: FeishuChannelConfig;
  messageId: string;
  imageKeys: string[];
  fileName?: string | null;
  deps?: FeishuMediaDependencies;
}): Promise<MessageImageAttachment[]> {
  const limitedKeys = args.imageKeys.slice(0, MAX_MESSAGE_IMAGE_ATTACHMENTS);
  const attachments: MessageImageAttachment[] = [];
  const logger = args.deps?.logger ?? appendFeishuRuntimeLog;

  for (const imageKey of limitedKeys) {
    try {
      attachments.push(await downloadFeishuImageAttachment({
        config: args.config,
        messageId: args.messageId,
        imageKey,
        fileName: args.fileName,
        deps: args.deps,
      }));
    } catch (error) {
      logger({
        level: "warn",
        message: "Failed to download Feishu image resource",
        details: {
          messageId: args.messageId,
          imageKey,
          error: error instanceof Error ? error.message : "Unknown Feishu image download error.",
        },
      });
    }
  }

  return attachments;
}
