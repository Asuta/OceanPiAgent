import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { roomWorkspaceStateSchema } from "@/lib/chat/schemas";
import type { AgentRoomTurn, RoomWorkspaceState } from "@/lib/chat/types";
import { createWorkspaceStatePatch, type WorkspaceStreamEvent } from "@/lib/chat/workspace-stream";
import { createDefaultWorkspaceState } from "@/lib/server/workspace-state";

export interface WorkspaceEnvelope {
  version: number;
  updatedAt: string;
  state: RoomWorkspaceState;
}

const WORKSPACE_ROOT = path.join(process.cwd(), ".oceanking", "workspace");
const WORKSPACE_FILE = path.join(WORKSPACE_ROOT, "state.json");
const DEFAULT_STALE_RUNNING_ROOM_TIMEOUT_MS = 150_000;

declare global {
  var __oceankingWorkspaceWriteQueue: Promise<void> | undefined;
  var __oceankingWorkspaceBroadcastQueue: Promise<void> | undefined;
  var __oceankingWorkspaceSubscribers: Map<string, (event: WorkspaceStreamEvent) => void> | undefined;
}

const workspaceSubscribers = globalThis.__oceankingWorkspaceSubscribers ?? new Map<string, (event: WorkspaceStreamEvent) => void>();
globalThis.__oceankingWorkspaceSubscribers = workspaceSubscribers;

function createTimestamp(): string {
  return new Date().toISOString();
}

function createDefaultEnvelope(): WorkspaceEnvelope {
  return {
    version: 0,
    updatedAt: createTimestamp(),
    state: createDefaultWorkspaceState(),
  };
}

async function ensureWorkspaceDir(): Promise<void> {
  await mkdir(WORKSPACE_ROOT, { recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeEnvelope(value: unknown): WorkspaceEnvelope {
  if (!isRecord(value)) {
    return createDefaultEnvelope();
  }

  const parsedState = roomWorkspaceStateSchema.safeParse(value.state);
  if (!parsedState.success) {
    return createDefaultEnvelope();
  }

  return {
    version: typeof value.version === "number" && Number.isFinite(value.version) ? Math.max(0, Math.floor(value.version)) : 0,
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt ? value.updatedAt : createTimestamp(),
    state: parsedState.data,
  };
}

function markTurnStopped(turn: AgentRoomTurn, reason: string): AgentRoomTurn {
  if (turn.status !== "running") {
    return turn;
  }

  return {
    ...turn,
    status: "error",
    error: reason,
  };
}

function getStaleRunningRoomTimeoutMs(): number {
  const raw = process.env.OCEANKING_STALE_RUNNING_ROOM_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_RUNNING_ROOM_TIMEOUT_MS;
}

function recoverStaleRunningRooms(state: RoomWorkspaceState, now = Date.now()): RoomWorkspaceState {
  const staleReason = "Recovered stale running room after the scheduler stopped updating.";
  const staleRoomIds = new Set<string>();
  const nextRooms = state.rooms.map((room) => {
    if (room.scheduler.status !== "running") {
      return room;
    }

    const updatedAtMs = Date.parse(room.updatedAt || "");
    if (!Number.isFinite(updatedAtMs) || now - updatedAtMs < getStaleRunningRoomTimeoutMs()) {
      return room;
    }

    staleRoomIds.add(room.id);
    return {
      ...room,
      scheduler: {
        ...room.scheduler,
        status: "idle" as const,
        activeParticipantId: null,
        roundCount: 0,
      },
      agentTurns: room.agentTurns.map((turn) => markTurnStopped(turn, staleReason)),
      error: "",
      updatedAt: createTimestamp(),
    };
  });

  if (staleRoomIds.size === 0) {
    return state;
  }

  const nextAgentStates = Object.fromEntries(
    Object.entries(state.agentStates).map(([agentId, agentState]) => [
      agentId,
      {
        ...agentState,
        agentTurns: agentState.agentTurns.map((turn) => (
          staleRoomIds.has(turn.userMessage.roomId) ? markTurnStopped(turn, staleReason) : turn
        )),
        updatedAt: createTimestamp(),
      },
    ]),
  ) as RoomWorkspaceState["agentStates"];

  return {
    ...state,
    rooms: nextRooms,
    agentStates: nextAgentStates,
  };
}

export async function loadWorkspaceEnvelope(): Promise<WorkspaceEnvelope> {
  await ensureWorkspaceDir();
  const raw = await readFile(WORKSPACE_FILE, "utf8").catch(() => "");
  if (!raw.trim()) {
    return createDefaultEnvelope();
  }

  try {
    const envelope = normalizeEnvelope(JSON.parse(raw) as unknown);
    return {
      ...envelope,
      state: recoverStaleRunningRooms(envelope.state),
    };
  } catch {
    return createDefaultEnvelope();
  }
}

async function writeWorkspaceEnvelope(envelope: WorkspaceEnvelope): Promise<void> {
  await ensureWorkspaceDir();
  await writeFile(WORKSPACE_FILE, JSON.stringify(envelope), "utf8");
}

function broadcastWorkspaceEvent(event: WorkspaceStreamEvent): void {
  for (const listener of workspaceSubscribers.values()) {
    listener(event);
  }
}

function queueWorkspaceEvent(eventFactory: () => WorkspaceStreamEvent): void {
  const previous = globalThis.__oceankingWorkspaceBroadcastQueue ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => {
      broadcastWorkspaceEvent(eventFactory());
    });
  globalThis.__oceankingWorkspaceBroadcastQueue = current;
  void current.catch(() => {
    // Best-effort event broadcast only.
  });
}

export function subscribeWorkspaceEvents(listener: (event: WorkspaceStreamEvent) => void): () => void {
  const subscriptionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  workspaceSubscribers.set(subscriptionId, listener);
  return () => {
    workspaceSubscribers.delete(subscriptionId);
  };
}

async function withWorkspaceWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.__oceankingWorkspaceWriteQueue ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.__oceankingWorkspaceWriteQueue = previous.then(() => current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function saveWorkspaceState(args: {
  state: RoomWorkspaceState;
  expectedVersion: number;
}): Promise<WorkspaceEnvelope> {
  const parsedState = roomWorkspaceStateSchema.parse(args.state);
  return withWorkspaceWriteLock(async () => {
    const current = await loadWorkspaceEnvelope();
    if (current.version !== args.expectedVersion) {
      const error = new Error("workspace version conflict");
      (error as Error & { code?: string; envelope?: WorkspaceEnvelope }).code = "VERSION_CONFLICT";
      (error as Error & { code?: string; envelope?: WorkspaceEnvelope }).envelope = current;
      throw error;
    }

    const nextEnvelope: WorkspaceEnvelope = {
      version: current.version + 1,
      updatedAt: createTimestamp(),
      state: parsedState,
    };
    await writeWorkspaceEnvelope(nextEnvelope);
    broadcastWorkspaceEvent({
      type: "patch",
      version: nextEnvelope.version,
      updatedAt: nextEnvelope.updatedAt,
      patch: createWorkspaceStatePatch(current.state, nextEnvelope.state),
    });
    return nextEnvelope;
  });
}

export async function mutateWorkspace(
  mutator: (state: RoomWorkspaceState) => RoomWorkspaceState | Promise<RoomWorkspaceState>,
): Promise<WorkspaceEnvelope> {
  return withWorkspaceWriteLock(async () => {
    const current = await loadWorkspaceEnvelope();
    const nextState = roomWorkspaceStateSchema.parse(await mutator(current.state));
    const nextEnvelope: WorkspaceEnvelope = {
      version: current.version + 1,
      updatedAt: createTimestamp(),
      state: nextState,
    };
    await writeWorkspaceEnvelope(nextEnvelope);
    broadcastWorkspaceEvent({
      type: "patch",
      version: nextEnvelope.version,
      updatedAt: nextEnvelope.updatedAt,
      patch: createWorkspaceStatePatch(current.state, nextEnvelope.state),
    });
    return nextEnvelope;
  });
}

export async function mutateWorkspaceWithResult<TResult>(
  mutator: (state: RoomWorkspaceState, envelope: WorkspaceEnvelope) => {
    state?: RoomWorkspaceState;
    result: TResult;
  } | Promise<{
    state?: RoomWorkspaceState;
    result: TResult;
  }>,
  options?: {
    deferPatchBroadcast?: boolean;
  },
): Promise<{
  envelope: WorkspaceEnvelope;
  result: TResult;
}> {
  return withWorkspaceWriteLock(async () => {
    const current = await loadWorkspaceEnvelope();
    const outcome = await mutator(current.state, current);
    if (typeof outcome.state === "undefined") {
      return {
        envelope: current,
        result: outcome.result,
      };
    }

    const nextState = roomWorkspaceStateSchema.parse(outcome.state);
    const nextEnvelope: WorkspaceEnvelope = {
      version: current.version + 1,
      updatedAt: createTimestamp(),
      state: nextState,
    };
    await writeWorkspaceEnvelope(nextEnvelope);
    const eventFactory = () => ({
      type: "patch" as const,
      version: nextEnvelope.version,
      updatedAt: nextEnvelope.updatedAt,
      patch: createWorkspaceStatePatch(current.state, nextEnvelope.state),
    });
    if (options?.deferPatchBroadcast) {
      queueWorkspaceEvent(eventFactory);
    } else {
      broadcastWorkspaceEvent(eventFactory());
    }
    return {
      envelope: nextEnvelope,
      result: outcome.result,
    };
  });
}
