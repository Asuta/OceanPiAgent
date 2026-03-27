import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type FeishuRuntimeLogLevel = "info" | "warn" | "error";

export interface FeishuRuntimeLogEntry {
  id: string;
  timestamp: string;
  level: FeishuRuntimeLogLevel;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

const LOG_ROOT = path.join(process.cwd(), ".oceanking", "channels");
const FEISHU_LOG_FILE = path.join(LOG_ROOT, "feishu-runtime.log");
const MAX_LOG_ENTRIES = 200;

declare global {
  var __oceankingFeishuRuntimeLogs: FeishuRuntimeLogEntry[] | undefined;
}

function createLogId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getMutableLogStore(): FeishuRuntimeLogEntry[] {
  if (!globalThis.__oceankingFeishuRuntimeLogs) {
    globalThis.__oceankingFeishuRuntimeLogs = [];
  }
  return globalThis.__oceankingFeishuRuntimeLogs;
}

async function ensureLogDir(): Promise<void> {
  await mkdir(LOG_ROOT, { recursive: true });
}

function formatLogLine(entry: FeishuRuntimeLogEntry): string {
  const detailsText = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
  return `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}${detailsText}\n`;
}

export function appendFeishuRuntimeLog(args: {
  level: FeishuRuntimeLogLevel;
  message: string;
  details?: Record<string, string | number | boolean | null | undefined>;
}): FeishuRuntimeLogEntry {
  const normalizedDetails: Record<string, string | number | boolean | null> | undefined = args.details
    ? Object.fromEntries(
        Object.entries(args.details).filter(([, value]) => value !== undefined),
      ) as Record<string, string | number | boolean | null>
    : undefined;
  const entry: FeishuRuntimeLogEntry = {
    id: createLogId(),
    timestamp: new Date().toISOString(),
    level: args.level,
    message: args.message,
    ...(normalizedDetails ? { details: normalizedDetails } : {}),
  };

  const logStore = getMutableLogStore();
  logStore.push(entry);
  if (logStore.length > MAX_LOG_ENTRIES) {
    logStore.splice(0, logStore.length - MAX_LOG_ENTRIES);
  }

  void ensureLogDir()
    .then(() => appendFile(FEISHU_LOG_FILE, formatLogLine(entry), "utf8"))
    .catch(() => {
      // Best-effort logging only.
    });

  return entry;
}

export function listFeishuRuntimeLogs(limit = 100): FeishuRuntimeLogEntry[] {
  const logStore = getMutableLogStore();
  return logStore.slice(Math.max(0, logStore.length - Math.max(1, limit)));
}

export function getFeishuRuntimeLogFilePath(): string {
  return FEISHU_LOG_FILE;
}
