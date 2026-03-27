import { readFeishuChannelConfig, type FeishuChannelConfig } from "@/lib/server/channel-config";

export type { FeishuChannelConfig };

export function getFeishuChannelConfig(): FeishuChannelConfig {
  return readFeishuChannelConfig();
}
