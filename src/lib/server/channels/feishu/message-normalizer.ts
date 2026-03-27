import { hasMessagePayload } from "@/lib/chat/message-attachments";
import type { MessageImageAttachment } from "@/lib/chat/types";
import type { ExternalInboundMessage, ExternalInboundMessageType } from "@/lib/server/channels/types";
import type { FeishuChannelConfig } from "@/lib/server/channels/feishu/config";
import { parseFeishuMessageContent } from "@/lib/server/channels/feishu/message-content";
import { resolveFeishuImageAttachments, type FeishuMediaDependencies } from "@/lib/server/channels/feishu/media";

type FeishuDirectMessageEvent = {
  sender?: {
    sender_type?: string;
    sender_id?: {
      open_id?: string;
    };
  };
  message?: {
    message_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
  };
};

function normalizeMessageType(value: string | undefined): ExternalInboundMessageType {
  const normalized = value?.trim().toLowerCase() || "unknown";
  switch (normalized) {
    case "text":
    case "image":
    case "post":
    case "file":
    case "audio":
    case "video":
    case "sticker":
      return normalized;
    case "media":
      return "video";
    default:
      return "unknown";
  }
}

export type FeishuNormalizerDependencies = FeishuMediaDependencies;

export async function normalizeFeishuInboundMessage(args: {
  event: unknown;
  config: FeishuChannelConfig;
  deps?: FeishuNormalizerDependencies;
}): Promise<ExternalInboundMessage | null> {
  const payload = args.event as FeishuDirectMessageEvent;
  const logger = args.deps?.logger;
  if (!payload || payload.sender?.sender_type === "app") {
    return null;
  }

  const chatType = payload.message?.chat_type?.trim();
  if (chatType !== "p2p" && chatType !== "private") {
    logger?.({
      level: "info",
      message: "Ignored Feishu event outside direct chat",
      details: {
        chatType: chatType || "unknown",
      },
    });
    return null;
  }

  const peerId = payload.sender?.sender_id?.open_id?.trim();
  const messageId = payload.message?.message_id?.trim();
  const messageType = normalizeMessageType(payload.message?.message_type);
  const rawContent = payload.message?.content?.trim() || "";
  if (!peerId || !messageId) {
    logger?.({
      level: "warn",
      message: "Ignored malformed Feishu event",
      details: {
        hasPeerId: Boolean(peerId),
        hasMessageId: Boolean(messageId),
      },
    });
    return null;
  }

  const parsedContent = parseFeishuMessageContent(messageType, rawContent);
  if (messageType !== "text" && messageType !== "image" && messageType !== "post") {
    logger?.({
      level: "warn",
      message: "Feishu inbound message type is not fully supported; using placeholder text",
      details: {
        messageId,
        messageType,
      },
    });
  }

  let attachments: MessageImageAttachment[] = [];
  if (parsedContent.imageKeys.length > 0) {
    attachments = await resolveFeishuImageAttachments({
      config: args.config,
      messageId,
      imageKeys: parsedContent.imageKeys,
      fileName: parsedContent.fileName,
      deps: args.deps,
    });
    if (attachments.length !== parsedContent.imageKeys.length) {
      logger?.({
        level: "warn",
        message: "Some Feishu image attachments could not be downloaded",
        details: {
          messageId,
          messageType,
          requestedCount: parsedContent.imageKeys.length,
          downloadedCount: attachments.length,
        },
      });
    }
  }

  const text = parsedContent.text || (attachments.length === 0 ? parsedContent.placeholderText : "");
  if (!hasMessagePayload(text, attachments)) {
    logger?.({
      level: "info",
      message: "Ignored empty Feishu message after normalization",
      details: {
        messageId,
        messageType,
      },
    });
    return null;
  }

  return {
    channel: "feishu",
    accountId: args.config.accountId,
    peerKind: "direct",
    peerId,
    messageId,
    messageType,
    text,
    attachments,
    senderId: peerId,
    senderName: peerId,
    agentId: args.config.defaultAgentId,
    rawContent,
    rawEvent: args.event,
  };
}
