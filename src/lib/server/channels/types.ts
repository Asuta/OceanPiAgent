import type { MessageImageAttachment } from "@/lib/chat/types";

export type ExternalChannelId = "feishu";

export type ExternalPeerKind = "direct" | "group";

export type ExternalInboundMessageType = "text" | "image" | "post" | "file" | "audio" | "video" | "sticker" | "unknown";

export interface ExternalInboundMessage {
  channel: ExternalChannelId;
  accountId: string;
  peerKind: ExternalPeerKind;
  peerId: string;
  messageId: string;
  messageType: ExternalInboundMessageType;
  text: string;
  attachments: MessageImageAttachment[];
  senderId: string;
  senderName: string;
  agentId?: string;
  rawContent?: string;
  rawEvent?: unknown;
}

export interface ExternalOutboundMessage {
  channel: ExternalChannelId;
  accountId: string;
  peerKind: ExternalPeerKind;
  peerId: string;
  roomId: string;
  content: string;
}

export interface ChannelBinding {
  bindingId: string;
  channel: ExternalChannelId;
  accountId: string;
  peerKind: ExternalPeerKind;
  peerId: string;
  roomId: string;
  humanParticipantId: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  lastInboundAt: string | null;
}
