export type ExternalChannelId = "feishu";

export type ExternalPeerKind = "direct" | "group";

export interface ExternalInboundMessage {
  channel: ExternalChannelId;
  accountId: string;
  peerKind: ExternalPeerKind;
  peerId: string;
  messageId: string;
  text: string;
  senderId: string;
  senderName: string;
  agentId?: string;
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
