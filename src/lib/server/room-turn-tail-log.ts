import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RoomAgentId } from "@/lib/chat/types";

export interface RoomTurnTailLogEntry {
  timestamp: string;
  requestId: string;
  roomId: string;
  agentId: RoomAgentId;
  userMessageId: string;
  phase: string;
  elapsedMs: number;
  sinceLastPhaseMs: number;
  details?: Record<string, string | number | boolean | null>;
}

const LOG_ROOT = path.join(process.cwd(), ".oceanking", "logs");
const ROOM_TURN_TAIL_LOG_FILE = path.join(LOG_ROOT, "room-turn-tail-timing.jsonl");

function shouldLogRoomTurnTailTiming(): boolean {
  const value = process.env.OCEANKING_LOG_ROOM_TURN_TAIL_TIMING?.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  return process.env.NODE_ENV !== "production";
}

function roundTimingMs(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

function normalizeDetails(details?: Record<string, unknown>): Record<string, string | number | boolean | null> | undefined {
  if (!details) {
    return undefined;
  }

  const entries = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
        return [key, value] as const;
      }
      return [key, JSON.stringify(value)] as const;
    });

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function appendRoomTurnTailLog(entry: RoomTurnTailLogEntry): void {
  if (!shouldLogRoomTurnTailTiming()) {
    return;
  }

  const serialized = `${JSON.stringify(entry)}\n`;
  void mkdir(LOG_ROOT, { recursive: true })
    .then(() => appendFile(ROOM_TURN_TAIL_LOG_FILE, serialized, "utf8"))
    .catch(() => {
      // Best-effort timing diagnostics only.
    });
}

export function createRoomTurnTailTrace(input: {
  requestId: string;
  roomId: string;
  agentId: RoomAgentId;
  userMessageId: string;
}) {
  const startedAt = performance.now();
  let lastPhaseAt = startedAt;

  return {
    mark(phase: string, details?: Record<string, unknown>) {
      const now = performance.now();
      appendRoomTurnTailLog({
        timestamp: new Date().toISOString(),
        requestId: input.requestId,
        roomId: input.roomId,
        agentId: input.agentId,
        userMessageId: input.userMessageId,
        phase,
        elapsedMs: roundTimingMs(now - startedAt),
        sinceLastPhaseMs: roundTimingMs(now - lastPhaseAt),
        ...(normalizeDetails(details) ? { details: normalizeDetails(details) } : {}),
      });
      lastPhaseAt = now;
    },
  };
}

export function getRoomTurnTailLogFilePath(): string {
  return ROOM_TURN_TAIL_LOG_FILE;
}
