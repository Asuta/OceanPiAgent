import assert from "node:assert/strict";
import test from "node:test";
import { applyFeishuAckReaction, applyFeishuDoneReaction } from "@/lib/server/channels/feishu/reaction-policy";
import type { ChannelMessageLink } from "@/lib/server/channels/types";

function createLink(): ChannelMessageLink {
  return {
    linkId: "link-1",
    channel: "feishu",
    accountId: "default",
    peerKind: "direct",
    peerId: "ou_123",
    externalMessageId: "om_123",
    roomId: "room-1",
    roomMessageId: "room-message-1",
    messageType: "text",
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:00:00.000Z",
  };
}

test("applyFeishuAckReaction applies and persists ACK reaction once", async () => {
  let link = createLink();
  let createCount = 0;

  link = await applyFeishuAckReaction(link, {
    readConfig: () => ({
      enabled: true,
      configured: true,
      accountId: "default",
      appId: "app-id",
      appSecret: "app-secret",
      defaultAgentId: "concierge",
      allowOpenIds: [],
      ackReactionEmojiType: "OK",
      doneReactionEmojiType: "DONE",
    }),
    getClient: () => ({
      im: {
        messageReaction: {
          create: async () => {
            createCount += 1;
            return { code: 0, data: { reaction_id: "ack-1" } };
          },
        },
      },
    }) as never,
    markReaction: async ({ reaction }) => {
      link = {
        ...link,
        ackReaction: reaction,
        updatedAt: reaction.appliedAt,
      };
      return link;
    },
    logger: () => undefined,
  });

  assert.equal(link.ackReaction?.emojiType, "OK");
  assert.equal(createCount, 1);

  const second = await applyFeishuAckReaction(link, {
    readConfig: () => ({
      enabled: true,
      configured: true,
      accountId: "default",
      appId: "app-id",
      appSecret: "app-secret",
      defaultAgentId: "concierge",
      allowOpenIds: [],
      ackReactionEmojiType: "OK",
      doneReactionEmojiType: "DONE",
    }),
    logger: () => undefined,
  });

  assert.equal(second.ackReaction?.emojiType, "OK");
  assert.equal(createCount, 1);
});

test("applyFeishuDoneReaction applies DONE reaction for read-no-reply flow", async () => {
  let link = createLink();

  link = await applyFeishuDoneReaction(link, {
    readConfig: () => ({
      enabled: true,
      configured: true,
      accountId: "default",
      appId: "app-id",
      appSecret: "app-secret",
      defaultAgentId: "concierge",
      allowOpenIds: [],
      ackReactionEmojiType: "OK",
      doneReactionEmojiType: "DONE",
    }),
    getClient: () => ({
      im: {
        messageReaction: {
          create: async () => ({ code: 0, data: { reaction_id: "done-1" } }),
        },
      },
    }) as never,
    markReaction: async ({ reaction }) => {
      link = {
        ...link,
        doneReaction: reaction,
        updatedAt: reaction.appliedAt,
      };
      return link;
    },
    logger: () => undefined,
  });

  assert.equal(link.doneReaction?.emojiType, "DONE");
  assert.equal(link.doneReaction?.reactionId, "done-1");
});
