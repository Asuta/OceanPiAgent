import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ChannelMessageLink, ChannelMessageReactionState, ExternalChannelId, ExternalPeerKind, ExternalInboundMessageType } from "@/lib/server/channels/types";

const reactionStateSchema = z.object({
  emojiType: z.string(),
  appliedAt: z.string(),
  reactionId: z.string().optional(),
}).strict();

const messageLinkSchema = z.object({
  linkId: z.string(),
  channel: z.literal("feishu"),
  accountId: z.string(),
  peerKind: z.enum(["direct", "group"]),
  peerId: z.string(),
  externalMessageId: z.string(),
  roomId: z.string(),
  roomMessageId: z.string(),
  messageType: z.enum(["text", "image", "post", "file", "audio", "video", "sticker", "unknown"]),
  ackReaction: reactionStateSchema.optional(),
  doneReaction: reactionStateSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

const messageLinksSchema = z.array(messageLinkSchema);

const CHANNELS_ROOT = path.join(process.cwd(), ".oceanking", "channels");
const CHANNEL_MESSAGE_LINKS_FILE = path.join(CHANNELS_ROOT, "message-links.json");

declare global {
  var __oceankingChannelMessageLinksWriteQueue: Promise<void> | undefined;
}

async function ensureChannelsDir(): Promise<void> {
  await mkdir(CHANNELS_ROOT, { recursive: true });
}

async function writeMessageLinks(links: ChannelMessageLink[]): Promise<void> {
  await ensureChannelsDir();
  await writeFile(CHANNEL_MESSAGE_LINKS_FILE, JSON.stringify(links, null, 2), "utf8");
}

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.__oceankingChannelMessageLinksWriteQueue ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.__oceankingChannelMessageLinksWriteQueue = previous.then(() => current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function loadChannelMessageLinks(): Promise<ChannelMessageLink[]> {
  await ensureChannelsDir();
  const raw = await readFile(CHANNEL_MESSAGE_LINKS_FILE, "utf8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }

  try {
    return messageLinksSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export async function findChannelMessageLink(args: {
  channel: ExternalChannelId;
  accountId: string;
  externalMessageId: string;
}): Promise<ChannelMessageLink | null> {
  const links = await loadChannelMessageLinks();
  return links.find((link) => link.channel === args.channel && link.accountId === args.accountId && link.externalMessageId === args.externalMessageId) ?? null;
}

export async function upsertChannelMessageLink(link: ChannelMessageLink): Promise<ChannelMessageLink> {
  const parsed = messageLinkSchema.parse(link);
  return withWriteLock(async () => {
    const links = await loadChannelMessageLinks();
    const index = links.findIndex((entry) => entry.channel === parsed.channel && entry.accountId === parsed.accountId && entry.externalMessageId === parsed.externalMessageId);
    const nextLinks = [...links];
    if (index >= 0) {
      nextLinks[index] = parsed;
    } else {
      nextLinks.push(parsed);
    }
    await writeMessageLinks(nextLinks);
    return parsed;
  });
}

export async function markChannelMessageReaction(args: {
  channel: ExternalChannelId;
  accountId: string;
  externalMessageId: string;
  reactionKind: "ackReaction" | "doneReaction";
  reaction: ChannelMessageReactionState;
}): Promise<ChannelMessageLink | null> {
  return withWriteLock(async () => {
    const links = await loadChannelMessageLinks();
    const index = links.findIndex((entry) => entry.channel === args.channel && entry.accountId === args.accountId && entry.externalMessageId === args.externalMessageId);
    if (index < 0) {
      return null;
    }
    const existing = links[index];
    if (!existing) {
      return null;
    }
    const nextLink: ChannelMessageLink = {
      ...existing,
      [args.reactionKind]: args.reaction,
      updatedAt: args.reaction.appliedAt,
    };
    const nextLinks = [...links];
    nextLinks[index] = nextLink;
    await writeMessageLinks(nextLinks);
    return nextLink;
  });
}

export function createChannelMessageLink(args: {
  linkId: string;
  channel: ExternalChannelId;
  accountId: string;
  peerKind: ExternalPeerKind;
  peerId: string;
  externalMessageId: string;
  roomId: string;
  roomMessageId: string;
  messageType: ExternalInboundMessageType;
  createdAt: string;
}): ChannelMessageLink {
  return {
    linkId: args.linkId,
    channel: args.channel,
    accountId: args.accountId,
    peerKind: args.peerKind,
    peerId: args.peerId,
    externalMessageId: args.externalMessageId,
    roomId: args.roomId,
    roomMessageId: args.roomMessageId,
    messageType: args.messageType,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  };
}
