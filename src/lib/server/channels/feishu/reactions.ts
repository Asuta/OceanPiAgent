import type { FeishuChannelConfig } from "@/lib/server/channel-config";
import { appendFeishuRuntimeLog } from "@/lib/server/channel-runtime-log";
import { getFeishuRestClient } from "@/lib/server/channels/feishu/client";

export interface FeishuReactionDependencies {
  getClient?: typeof getFeishuRestClient;
  logger?: typeof appendFeishuRuntimeLog | ((args: {
    level: "info" | "warn" | "error";
    message: string;
    details?: Record<string, string | number | boolean | null | undefined>;
  }) => unknown);
}

export async function createFeishuReaction(args: {
  config: FeishuChannelConfig;
  externalMessageId: string;
  emojiType: string;
  deps?: FeishuReactionDependencies;
}): Promise<{ reactionId?: string }> {
  const getClient = args.deps?.getClient ?? getFeishuRestClient;
  const logger = args.deps?.logger ?? appendFeishuRuntimeLog;
  const client = getClient(args.config);

  logger({
    level: "info",
    message: "Applying Feishu reaction",
    details: {
      externalMessageId: args.externalMessageId,
      emojiType: args.emojiType,
    },
  });

  const response = await client.im.messageReaction.create({
    path: {
      message_id: args.externalMessageId,
    },
    data: {
      reaction_type: {
        emoji_type: args.emojiType,
      },
    },
  });

  if (typeof response.code === "number" && response.code !== 0) {
    throw new Error(response.msg || `Feishu reaction create failed with code ${response.code}.`);
  }

  return {
    reactionId: response.data?.reaction_id,
  };
}
