import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RoomCronJob, RoomCronRunRecord, RoomCronSchedule } from "@/lib/chat/types";
import { createUuid } from "@/lib/utils/uuid";

interface CronStoreData {
  jobs: RoomCronJob[];
  runs: RoomCronRunRecord[];
}

const CRON_ROOT = path.join(process.cwd(), ".oceanking", "cron");
const CRON_FILE = path.join(CRON_ROOT, "store.json");
const MAX_RUNS = 200;

declare global {
  var __oceankingCronWriteQueue: Promise<void> | undefined;
}

function createEmptyStore(): CronStoreData {
  return {
    jobs: [],
    runs: [],
  };
}

function createTimestamp(): string {
  return new Date().toISOString();
}

async function ensureCronDir(): Promise<void> {
  await mkdir(CRON_ROOT, { recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeStore(value: unknown): CronStoreData {
  if (!isRecord(value)) {
    return createEmptyStore();
  }
  return {
    jobs: Array.isArray(value.jobs) ? (value.jobs as RoomCronJob[]) : [],
    runs: Array.isArray(value.runs) ? (value.runs as RoomCronRunRecord[]).slice(-MAX_RUNS) : [],
  };
}

async function withCronWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.__oceankingCronWriteQueue ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.__oceankingCronWriteQueue = previous.then(() => current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function loadCronStore(): Promise<CronStoreData> {
  await ensureCronDir();
  const raw = await readFile(CRON_FILE, "utf8").catch(() => "");
  if (!raw.trim()) {
    return createEmptyStore();
  }
  try {
    return normalizeStore(JSON.parse(raw) as unknown);
  } catch {
    return createEmptyStore();
  }
}

async function writeCronStore(store: CronStoreData): Promise<void> {
  await ensureCronDir();
  await writeFile(CRON_FILE, JSON.stringify({ ...store, runs: store.runs.slice(-MAX_RUNS) }, null, 2), "utf8");
}

export async function mutateCronStore(mutator: (store: CronStoreData) => CronStoreData | Promise<CronStoreData>): Promise<CronStoreData> {
  return withCronWriteLock(async () => {
    const current = await loadCronStore();
    const next = await mutator(current);
    next.runs = next.runs.slice(-MAX_RUNS);
    await writeCronStore(next);
    return next;
  });
}

function parseTimeString(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time.trim());
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function nextDailyOccurrence(schedule: Extract<RoomCronSchedule, { type: "daily" }>, now: Date): Date | null {
  const parsedTime = parseTimeString(schedule.time);
  if (!parsedTime) {
    return null;
  }
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setHours(parsedTime.hour, parsedTime.minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function nextWeeklyOccurrence(schedule: Extract<RoomCronSchedule, { type: "weekly" }>, now: Date): Date | null {
  const parsedTime = parseTimeString(schedule.time);
  if (!parsedTime) {
    return null;
  }
  if (!Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6) {
    return null;
  }
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setHours(parsedTime.hour, parsedTime.minute, 0, 0);
  const currentDay = candidate.getDay();
  let dayOffset = schedule.dayOfWeek - currentDay;
  if (dayOffset < 0 || (dayOffset === 0 && candidate.getTime() <= now.getTime())) {
    dayOffset += 7;
  }
  candidate.setDate(candidate.getDate() + dayOffset);
  return candidate;
}

export function computeNextRunAt(schedule: RoomCronSchedule, now = new Date()): string | null {
  if (schedule.type === "once") {
    const at = new Date(schedule.at);
    if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) {
      return null;
    }
    return at.toISOString();
  }
  if (schedule.type === "daily") {
    return nextDailyOccurrence(schedule, now)?.toISOString() ?? null;
  }
  return nextWeeklyOccurrence(schedule, now)?.toISOString() ?? null;
}

export function computeFollowingRunAt(schedule: RoomCronSchedule, fromIso: string): string | null {
  const base = new Date(fromIso);
  if (Number.isNaN(base.getTime())) {
    return null;
  }
  if (schedule.type === "once") {
    return null;
  }
  const nextBase = new Date(base.getTime() + 60_000);
  return computeNextRunAt(schedule, nextBase);
}

export function describeSchedule(schedule: RoomCronSchedule): string {
  if (schedule.type === "once") {
    return `单次 · ${schedule.at}`;
  }
  if (schedule.type === "daily") {
    return `每天 ${schedule.time}`;
  }
  const dayLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${dayLabels[schedule.dayOfWeek] ?? "每周"} ${schedule.time}`;
}

export function createCronJob(input: Omit<RoomCronJob, "id" | "status" | "lastRunAt" | "nextRunAt" | "lastError" | "createdAt" | "updatedAt">): RoomCronJob {
  const timestamp = createTimestamp();
  return {
    ...input,
    id: createUuid(),
    status: "idle",
    lastRunAt: null,
    nextRunAt: input.enabled ? computeNextRunAt(input.schedule) : null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createCronRunRecord(job: RoomCronJob, scheduledFor: string): RoomCronRunRecord {
  return {
    id: createUuid(),
    jobId: job.id,
    agentId: job.agentId,
    targetRoomId: job.targetRoomId,
    scheduledFor,
    startedAt: createTimestamp(),
    finishedAt: null,
    status: "running",
    summary: "",
    error: null,
  };
}
