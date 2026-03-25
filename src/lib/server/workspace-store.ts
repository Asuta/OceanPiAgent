import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { roomWorkspaceStateSchema } from "@/lib/chat/schemas";
import type { RoomWorkspaceState } from "@/lib/chat/types";
import { createDefaultWorkspaceState } from "@/lib/server/workspace-state";

export interface WorkspaceEnvelope {
  version: number;
  updatedAt: string;
  state: RoomWorkspaceState;
}

const WORKSPACE_ROOT = path.join(process.cwd(), ".oceanking", "workspace");
const WORKSPACE_FILE = path.join(WORKSPACE_ROOT, "state.json");

declare global {
  var __oceankingWorkspaceWriteQueue: Promise<void> | undefined;
}

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

export async function loadWorkspaceEnvelope(): Promise<WorkspaceEnvelope> {
  await ensureWorkspaceDir();
  const raw = await readFile(WORKSPACE_FILE, "utf8").catch(() => "");
  if (!raw.trim()) {
    return createDefaultEnvelope();
  }

  try {
    return normalizeEnvelope(JSON.parse(raw) as unknown);
  } catch {
    return createDefaultEnvelope();
  }
}

async function writeWorkspaceEnvelope(envelope: WorkspaceEnvelope): Promise<void> {
  await ensureWorkspaceDir();
  await writeFile(WORKSPACE_FILE, JSON.stringify(envelope, null, 2), "utf8");
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
    return nextEnvelope;
  });
}
