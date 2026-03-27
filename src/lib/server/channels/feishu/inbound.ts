import type { ExternalInboundMessage } from "@/lib/server/channels/types";
import type { FeishuChannelConfig } from "@/lib/server/channels/feishu/config";
import { normalizeFeishuInboundMessage, type FeishuNormalizerDependencies } from "@/lib/server/channels/feishu/message-normalizer";

export async function parseFeishuInboundMessage(
  event: unknown,
  config: FeishuChannelConfig,
  deps?: FeishuNormalizerDependencies,
): Promise<ExternalInboundMessage | null> {
  return normalizeFeishuInboundMessage({
    event,
    config,
    deps,
  });
}
