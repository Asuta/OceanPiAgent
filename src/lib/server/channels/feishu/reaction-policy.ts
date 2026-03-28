import { createTimestamp } from "@/lib/chat/workspace-domain";
import { markChannelMessageReaction } from "@/lib/server/channel-message-links-store";
import { readFeishuChannelConfig, type FeishuChannelConfig } from "@/lib/server/channel-config";
import { appendFeishuRuntimeLog } from "@/lib/server/channel-runtime-log";
import { createFeishuReaction, type FeishuReactionDependencies } from "@/lib/server/channels/feishu/reactions";
import type { ChannelMessageLink } from "@/lib/server/channels/types";

export interface FeishuReactionPolicyDependencies extends FeishuReactionDependencies {
  readConfig?: typeof readFeishuChannelConfig;
  markReaction?: typeof markChannelMessageReaction;
  logger?: typeof appendFeishuRuntimeLog | ((args: {
    level: "info" | "warn" | "error";
    message: string;
    details?: Record<string, string | number | boolean | null | undefined>;
  }) => unknown);
}

async function applyReactionIfMissing(args: {
  link: ChannelMessageLink;
  reactionKind: "ackReaction" | "doneReaction";
  emojiType: string;
  deps?: FeishuReactionPolicyDependencies;
  config?: FeishuChannelConfig;
}): Promise<ChannelMessageLink> {
  const logger = args.deps?.logger ?? appendFeishuRuntimeLog;
  const markReaction = args.deps?.markReaction ?? markChannelMessageReaction;
  if (args.link[args.reactionKind]) {
    logger({
      level: "info",
      message: `Skipped duplicate Feishu ${args.reactionKind === "ackReaction" ? "ACK" : "DONE"} reaction`,
      details: {
        externalMessageId: args.link.externalMessageId,
        roomMessageId: args.link.roomMessageId,
        emojiType: args.link[args.reactionKind]?.emojiType,
      },
    });
    return args.link;
  }

  const config = args.config ?? (args.deps?.readConfig ?? readFeishuChannelConfig)();
  const createdAt = createTimestamp();
  const result = await createFeishuReaction({
    config,
    externalMessageId: args.link.externalMessageId,
    emojiType: args.emojiType,
    deps: args.deps,
  });
  const nextLink = await markReaction({
    channel: args.link.channel,
    accountId: args.link.accountId,
    externalMessageId: args.link.externalMessageId,
    reactionKind: args.reactionKind,
    reaction: {
      emojiType: args.emojiType,
      appliedAt: createdAt,
      ...(result.reactionId ? { reactionId: result.reactionId } : {}),
    },
  });
  if (!nextLink) {
    throw new Error(`Unable to persist Feishu ${args.reactionKind} reaction state.`);
  }

  logger({
    level: "info",
    message: `Applied Feishu ${args.reactionKind === "ackReaction" ? "ACK" : "DONE"} reaction`,
    details: {
      externalMessageId: args.link.externalMessageId,
      roomMessageId: args.link.roomMessageId,
      emojiType: args.emojiType,
      reactionId: result.reactionId || null,
    },
  });
  return nextLink;
}

export async function applyFeishuAckReaction(link: ChannelMessageLink, deps?: FeishuReactionPolicyDependencies): Promise<ChannelMessageLink> {
  const config = (deps?.readConfig ?? readFeishuChannelConfig)();
  return applyReactionIfMissing({
    link,
    reactionKind: "ackReaction",
    emojiType: config.ackReactionEmojiType,
    deps,
    config,
  });
}

export async function applyFeishuDoneReaction(link: ChannelMessageLink, deps?: FeishuReactionPolicyDependencies): Promise<ChannelMessageLink> {
  const config = (deps?.readConfig ?? readFeishuChannelConfig)();
  return applyReactionIfMissing({
    link,
    reactionKind: "doneReaction",
    emojiType: config.doneReactionEmojiType,
    deps,
    config,
  });
}
