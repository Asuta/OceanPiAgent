import type { ExternalInboundMessage } from "@/lib/server/channels/types";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTextContent(rawContent: string | undefined): string {
  if (!rawContent) {
    return "";
  }
  try {
    const parsed = JSON.parse(rawContent) as unknown;
    if (isRecord(parsed) && typeof parsed.text === "string") {
      return parsed.text.trim();
    }
  } catch {
    return rawContent.trim();
  }
  return "";
}

export function parseFeishuInboundMessage(event: unknown, accountId: string, defaultAgentId: string): ExternalInboundMessage | null {
  const payload = event as FeishuDirectMessageEvent;
  if (!payload || payload.sender?.sender_type === "app") {
    return null;
  }

  const chatType = payload.message?.chat_type?.trim();
  if (chatType !== "p2p" && chatType !== "private") {
    return null;
  }

  const messageType = payload.message?.message_type?.trim();
  if (messageType !== "text") {
    return null;
  }

  const peerId = payload.sender?.sender_id?.open_id?.trim();
  const messageId = payload.message?.message_id?.trim();
  const text = parseTextContent(payload.message?.content);
  if (!peerId || !messageId || !text) {
    return null;
  }

  return {
    channel: "feishu",
    accountId,
    peerKind: "direct",
    peerId,
    messageId,
    text,
    senderId: peerId,
    senderName: peerId,
    agentId: defaultAgentId,
    rawEvent: event,
  };
}
