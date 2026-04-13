import { readFile } from "node:fs/promises";
import path from "node:path";

type LogEntry = {
  timestamp: string;
  requestId: string;
  roomId: string;
  agentId: string;
  userMessageId: string;
  phase: string;
  elapsedMs: number;
  sinceLastPhaseMs: number;
  details?: Record<string, string | number | boolean | null>;
};

const logPath = path.join(process.cwd(), ".oceanking", "logs", "room-turn-tail-timing.jsonl");
const requestedRequestId = process.argv[2]?.trim() || "";

async function main() {
  const raw = await readFile(logPath, "utf8");
  const entries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);

  if (entries.length === 0) {
    throw new Error(`No timing entries found in ${logPath}`);
  }

  const requestId = requestedRequestId || entries[entries.length - 1]!.requestId;
  const selected = entries.filter((entry) => entry.requestId === requestId);
  if (selected.length === 0) {
    throw new Error(`No timing entries found for requestId ${requestId}`);
  }

  const sorted = [...selected].sort((left, right) => left.elapsedMs - right.elapsedMs);
  const longest = [...sorted].sort((left, right) => right.sinceLastPhaseMs - left.sinceLastPhaseMs)[0]!;

  console.log(JSON.stringify({
    requestId,
    roomId: sorted[0]!.roomId,
    agentId: sorted[0]!.agentId,
    userMessageId: sorted[0]!.userMessageId,
    totalElapsedMs: sorted[sorted.length - 1]!.elapsedMs,
    longestGap: {
      phase: longest.phase,
      sinceLastPhaseMs: longest.sinceLastPhaseMs,
      details: longest.details ?? null,
    },
    phases: sorted.map((entry) => ({
      timestamp: entry.timestamp,
      phase: entry.phase,
      elapsedMs: entry.elapsedMs,
      sinceLastPhaseMs: entry.sinceLastPhaseMs,
      details: entry.details ?? null,
    })),
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
