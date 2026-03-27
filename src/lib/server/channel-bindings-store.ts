import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ChannelBinding, ExternalChannelId, ExternalPeerKind } from "@/lib/server/channels/types";

const channelBindingSchema = z.object({
  bindingId: z.string(),
  channel: z.literal("feishu"),
  accountId: z.string(),
  peerKind: z.enum(["direct", "group"]),
  peerId: z.string(),
  roomId: z.string(),
  humanParticipantId: z.string(),
  agentId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastInboundAt: z.string().nullable(),
}).strict();

const channelBindingsSchema = z.array(channelBindingSchema);

const CHANNELS_ROOT = path.join(process.cwd(), ".oceanking", "channels");
const CHANNEL_BINDINGS_FILE = path.join(CHANNELS_ROOT, "bindings.json");

declare global {
  var __oceankingChannelBindingsWriteQueue: Promise<void> | undefined;
}

function createTimestamp(): string {
  return new Date().toISOString();
}

async function ensureChannelsDir(): Promise<void> {
  await mkdir(CHANNELS_ROOT, { recursive: true });
}

async function writeBindings(bindings: ChannelBinding[]): Promise<void> {
  await ensureChannelsDir();
  await writeFile(CHANNEL_BINDINGS_FILE, JSON.stringify(bindings, null, 2), "utf8");
}

async function withBindingsWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.__oceankingChannelBindingsWriteQueue ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.__oceankingChannelBindingsWriteQueue = previous.then(() => current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function loadChannelBindings(): Promise<ChannelBinding[]> {
  await ensureChannelsDir();
  const raw = await readFile(CHANNEL_BINDINGS_FILE, "utf8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return channelBindingsSchema.parse(parsed);
  } catch {
    return [];
  }
}

export async function findChannelBinding(args: {
  channel: ExternalChannelId;
  accountId: string;
  peerKind: ExternalPeerKind;
  peerId: string;
}): Promise<ChannelBinding | null> {
  const bindings = await loadChannelBindings();
  return bindings.find((binding) => (
    binding.channel === args.channel
    && binding.accountId === args.accountId
    && binding.peerKind === args.peerKind
    && binding.peerId === args.peerId
  )) ?? null;
}

export async function upsertChannelBinding(binding: ChannelBinding): Promise<ChannelBinding> {
  const parsedBinding = channelBindingSchema.parse(binding);
  return withBindingsWriteLock(async () => {
    const bindings = await loadChannelBindings();
    const existingIndex = bindings.findIndex((entry) => (
      entry.channel === parsedBinding.channel
      && entry.accountId === parsedBinding.accountId
      && entry.peerKind === parsedBinding.peerKind
      && entry.peerId === parsedBinding.peerId
    ));
    const nextBindings = [...bindings];
    if (existingIndex >= 0) {
      nextBindings[existingIndex] = parsedBinding;
    } else {
      nextBindings.push(parsedBinding);
    }
    await writeBindings(nextBindings);
    return parsedBinding;
  });
}

export async function touchChannelBinding(args: {
  channel: ExternalChannelId;
  accountId: string;
  peerKind: ExternalPeerKind;
  peerId: string;
  lastInboundAt?: string;
}): Promise<ChannelBinding | null> {
  return withBindingsWriteLock(async () => {
    const bindings = await loadChannelBindings();
    const existingIndex = bindings.findIndex((binding) => (
      binding.channel === args.channel
      && binding.accountId === args.accountId
      && binding.peerKind === args.peerKind
      && binding.peerId === args.peerId
    ));
    if (existingIndex < 0) {
      return null;
    }
    const existing = bindings[existingIndex];
    if (!existing) {
      return null;
    }
    const nextBinding: ChannelBinding = {
      ...existing,
      updatedAt: createTimestamp(),
      lastInboundAt: args.lastInboundAt ?? createTimestamp(),
    };
    const nextBindings = [...bindings];
    nextBindings[existingIndex] = nextBinding;
    await writeBindings(nextBindings);
    return nextBinding;
  });
}
