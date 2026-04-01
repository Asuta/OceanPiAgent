import type { RoomMessage } from "@/lib/chat/types";
import { loadChannelBindings } from "@/lib/server/channel-bindings-store";
import { appendFeishuRuntimeLog } from "@/lib/server/channel-runtime-log";
import { getFeishuChannelConfig } from "@/lib/server/channels/feishu/config";
import { deliverFeishuMessages } from "@/lib/server/channels/feishu/outbound";
import type { ChannelBinding, ExternalOutboundMessage } from "@/lib/server/channels/types";

export function createExternalOutboundMessages(binding: ChannelBinding, emittedMessages: RoomMessage[]): ExternalOutboundMessage[] {
  return emittedMessages
    .filter((message) => message.roomId === binding.roomId && message.final && message.status === "completed" && message.content.trim())
    .map((message) => ({
      channel: binding.channel,
      accountId: binding.accountId,
      peerKind: binding.peerKind,
      peerId: binding.peerId,
      roomId: binding.roomId,
      content: message.content,
    }));
}

export async function deliverBoundRoomMessages(
  emittedMessages: RoomMessage[],
  overrides: {
    loadBindings?: typeof loadChannelBindings;
    deliverFeishuMessages?: typeof deliverFeishuMessages;
    logger?: typeof appendFeishuRuntimeLog;
  } = {},
): Promise<number> {
  const loadBindings = overrides.loadBindings ?? loadChannelBindings;
  const deliver = overrides.deliverFeishuMessages ?? deliverFeishuMessages;
  const logger = overrides.logger ?? appendFeishuRuntimeLog;
  const bindings = await loadBindings();
  const outboundMessages = bindings.flatMap((binding) => createExternalOutboundMessages(binding, emittedMessages));
  if (outboundMessages.length === 0) {
    return 0;
  }

  const feishuMessages = outboundMessages.filter((message) => message.channel === "feishu");
  if (feishuMessages.length === 0) {
    return 0;
  }

  logger({
    level: "info",
    message: "Delivering bound room outbound messages",
    details: {
      count: feishuMessages.length,
      roomCount: new Set(feishuMessages.map((message) => message.roomId)).size,
    },
  });

  try {
    await deliver(feishuMessages, getFeishuChannelConfig());
    return feishuMessages.length;
  } catch (error) {
    logger({
      level: "error",
      message: "Failed to deliver bound room outbound messages",
      details: {
        count: feishuMessages.length,
        error: error instanceof Error ? error.message : "Unknown outbound delivery error.",
      },
    });
    return 0;
  }
}
