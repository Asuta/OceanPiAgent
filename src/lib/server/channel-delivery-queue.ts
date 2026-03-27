import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type QueueTask<T> = () => Promise<T>;

const queueByKey = new Map<string, Promise<unknown>>();

const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const CLAIM_STALE_AFTER_MS = 30 * 60 * 1000;
const processedMessageIds = new Map<string, number>();
const inFlightMessageIds = new Set<string>();

const MESSAGE_DEDUPE_ROOT = path.join(process.cwd(), ".oceanking", "channels", "message-dedupe");
const MESSAGE_DEDUPE_CLAIMS_DIR = path.join(MESSAGE_DEDUPE_ROOT, "claims");
const MESSAGE_DEDUPE_PROCESSED_DIR = path.join(MESSAGE_DEDUPE_ROOT, "processed");

function getMessageDedupeHash(messageKey: string): string {
  return createHash("sha1").update(messageKey).digest("hex");
}

function getClaimPath(messageKey: string): string {
  return path.join(MESSAGE_DEDUPE_CLAIMS_DIR, `${getMessageDedupeHash(messageKey)}.json`);
}

function getProcessedPath(messageKey: string): string {
  return path.join(MESSAGE_DEDUPE_PROCESSED_DIR, `${getMessageDedupeHash(messageKey)}.json`);
}

async function ensureMessageDedupeDirs(): Promise<void> {
  await mkdir(MESSAGE_DEDUPE_CLAIMS_DIR, { recursive: true });
  await mkdir(MESSAGE_DEDUPE_PROCESSED_DIR, { recursive: true });
}

async function hasFreshProcessedRecord(messageKey: string, now = Date.now()): Promise<boolean> {
  const processedPath = getProcessedPath(messageKey);
  try {
    const raw = await readFile(processedPath, "utf8");
    const parsed = JSON.parse(raw) as { expiresAt?: number };
    if (typeof parsed.expiresAt === "number" && parsed.expiresAt > now) {
      return true;
    }
  } catch {
    // Ignore missing or malformed records and let processing continue.
  }

  await rm(processedPath, { force: true }).catch(() => {});
  return false;
}

async function tryAcquireClaim(messageKey: string, now = Date.now()): Promise<boolean> {
  const claimPath = getClaimPath(messageKey);
  const payload = JSON.stringify({ claimedAt: now, messageKey });

  try {
    await writeFile(claimPath, payload, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    const duplicateClaim = error instanceof Error && "code" in error && error.code === "EEXIST";
    if (!duplicateClaim) {
      throw error;
    }
  }

  try {
    const existing = await stat(claimPath);
    if (now - existing.mtimeMs > CLAIM_STALE_AFTER_MS) {
      await rm(claimPath, { force: true });
      await writeFile(claimPath, payload, { encoding: "utf8", flag: "wx" });
      return true;
    }
  } catch {
    // Ignore races between competing processes and fall through.
  }

  return false;
}

async function markProcessed(messageKey: string, now = Date.now()): Promise<void> {
  await writeFile(
    getProcessedPath(messageKey),
    JSON.stringify({ completedAt: now, expiresAt: now + DEDUPE_TTL_MS, messageKey }),
    "utf8",
  );
}

async function releaseClaim(messageKey: string): Promise<void> {
  await rm(getClaimPath(messageKey), { force: true }).catch(() => {});
}

function pruneProcessedMessages(now = Date.now()): void {
  for (const [key, expiresAt] of processedMessageIds.entries()) {
    if (expiresAt <= now) {
      processedMessageIds.delete(key);
    }
  }
}

export async function runSerializedDelivery<T>(queueKey: string, task: QueueTask<T>): Promise<T> {
  const previous = queueByKey.get(queueKey) ?? Promise.resolve();
  const current = previous.then(task, task);
  queueByKey.set(queueKey, current);

  try {
    return await current;
  } finally {
    if (queueByKey.get(queueKey) === current) {
      queueByKey.delete(queueKey);
    }
  }
}

export async function beginInboundMessage(messageKey: string): Promise<"started" | "processed" | "in_flight"> {
  const now = Date.now();
  pruneProcessedMessages(now);
  if (processedMessageIds.has(messageKey)) {
    return "processed";
  }
  if (inFlightMessageIds.has(messageKey)) {
    return "in_flight";
  }

  await ensureMessageDedupeDirs();
  if (await hasFreshProcessedRecord(messageKey, now)) {
    processedMessageIds.set(messageKey, now + DEDUPE_TTL_MS);
    return "processed";
  }

  if (!(await tryAcquireClaim(messageKey, now))) {
    if (await hasFreshProcessedRecord(messageKey, now)) {
      processedMessageIds.set(messageKey, now + DEDUPE_TTL_MS);
      return "processed";
    }
    return "in_flight";
  }

  inFlightMessageIds.add(messageKey);
  return "started";
}

export async function finishInboundMessage(messageKey: string, succeeded: boolean): Promise<void> {
  inFlightMessageIds.delete(messageKey);
  if (succeeded) {
    processedMessageIds.set(messageKey, Date.now() + DEDUPE_TTL_MS);
    await ensureMessageDedupeDirs();
    await markProcessed(messageKey);
  }
  await releaseClaim(messageKey);
}

export async function resetChannelDeliveryStateForTest(): Promise<void> {
  queueByKey.clear();
  processedMessageIds.clear();
  inFlightMessageIds.clear();
  await rm(MESSAGE_DEDUPE_ROOT, { recursive: true, force: true }).catch(() => {});
}
