type QueueTask<T> = () => Promise<T>;

const queueByKey = new Map<string, Promise<unknown>>();

const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const processedMessageIds = new Map<string, number>();
const inFlightMessageIds = new Set<string>();

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

export function beginInboundMessage(messageKey: string): "started" | "processed" | "in_flight" {
  const now = Date.now();
  pruneProcessedMessages(now);
  if (processedMessageIds.has(messageKey)) {
    return "processed";
  }
  if (inFlightMessageIds.has(messageKey)) {
    return "in_flight";
  }
  inFlightMessageIds.add(messageKey);
  return "started";
}

export function finishInboundMessage(messageKey: string, succeeded: boolean): void {
  inFlightMessageIds.delete(messageKey);
  if (succeeded) {
    processedMessageIds.set(messageKey, Date.now() + DEDUPE_TTL_MS);
  }
}

export function resetChannelDeliveryStateForTest(): void {
  queueByKey.clear();
  processedMessageIds.clear();
  inFlightMessageIds.clear();
}
