import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { roomWorkspaceStateSchema } from "@/lib/chat/schemas";
import type { RoomWorkspaceState } from "@/lib/chat/types";
import { createAgentSharedState, sortRoomsForDisplay, upsertRoomMessages } from "@/lib/chat/workspace-domain";
import { createWorkspaceStatePatch, type WorkspaceStreamEvent } from "@/lib/chat/workspace-stream";
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

function broadcastWorkspaceEvent(event: WorkspaceStreamEvent): void {
  for (const listener of workspaceSubscribers.values()) {
    listener(event);
  }
}

function mergeAgentTurnsPreservingServerHistory(
  serverTurns: NonNullable<RoomWorkspaceState["agentStates"][string]>["agentTurns"],
  proposedTurns: NonNullable<RoomWorkspaceState["agentStates"][string]>["agentTurns"],
) {
  const proposedById = new Map(proposedTurns.map((turn) => [turn.id, turn]));
  const serverTurnIds = new Set(serverTurns.map((turn) => turn.id));
  const mergedTurns = [
    ...serverTurns.map((turn) => proposedById.get(turn.id) ?? turn),
    ...proposedTurns.filter((turn) => !serverTurnIds.has(turn.id)),
  ];

  return mergedTurns;
}

function mergeRoomMessagesPreservingServerHistory(
  serverMessages: RoomWorkspaceState["rooms"][number]["roomMessages"],
  proposedMessages: RoomWorkspaceState["rooms"][number]["roomMessages"],
) {
  let mergedMessages = serverMessages;

  for (const message of proposedMessages) {
    mergedMessages = upsertRoomMessages(mergedMessages, message);
  }

  return mergedMessages;
}

function mergeRoomsPreservingServerState(
  serverRooms: RoomWorkspaceState["rooms"],
  proposedRooms: RoomWorkspaceState["rooms"],
) {
  const proposedRoomsById = new Map(proposedRooms.map((room) => [room.id, room]));
  const mergedRooms = serverRooms.map((room) => {
    const proposedRoom = proposedRoomsById.get(room.id);
    if (!proposedRoom) {
      return room;
    }

    return {
      ...room,
      roomMessages: mergeRoomMessagesPreservingServerHistory(room.roomMessages, proposedRoom.roomMessages),
      agentTurns: mergeAgentTurnsPreservingServerHistory(room.agentTurns, proposedRoom.agentTurns),
    };
  });

  const existingRoomIds = new Set(serverRooms.map((room) => room.id));
  mergedRooms.push(...proposedRooms.filter((room) => !existingRoomIds.has(room.id)));
  return sortRoomsForDisplay(mergedRooms);
}

function mergeAgentStatesPreservingServerState(
  serverAgentStates: RoomWorkspaceState["agentStates"],
  proposedAgentStates: RoomWorkspaceState["agentStates"],
) {
  const mergedAgentStates: RoomWorkspaceState["agentStates"] = { ...serverAgentStates };

  for (const [agentId, proposedState] of Object.entries(proposedAgentStates)) {
    const serverState = serverAgentStates[agentId];
    if (!serverState) {
      mergedAgentStates[agentId] = proposedState;
      continue;
    }

    mergedAgentStates[agentId] = {
      ...createAgentSharedState(),
      ...serverState,
      settings: proposedState.settings,
      agentTurns: mergeAgentTurnsPreservingServerHistory(serverState.agentTurns, proposedState.agentTurns),
    };
  }

  return mergedAgentStates;
}

function mergeClientWorkspaceStateIntoServerState(
  serverState: RoomWorkspaceState,
  proposedState: RoomWorkspaceState,
): RoomWorkspaceState {
  const mergedRooms = mergeRoomsPreservingServerState(serverState.rooms, proposedState.rooms);
  const mergedAgentStates = mergeAgentStatesPreservingServerState(serverState.agentStates, proposedState.agentStates);
  const activeRoomId = mergedRooms.some((room) => room.id === proposedState.activeRoomId)
    ? proposedState.activeRoomId
    : serverState.activeRoomId;
  const selectedConsoleAgentId = proposedState.selectedConsoleAgentId && mergedAgentStates[proposedState.selectedConsoleAgentId]
    ? proposedState.selectedConsoleAgentId
    : serverState.selectedConsoleAgentId;

  return {
    ...serverState,
    rooms: mergedRooms,
    agentStates: mergedAgentStates,
    activeRoomId,
    ...(selectedConsoleAgentId ? { selectedConsoleAgentId } : {}),
  };
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

    const mergedState = current.version === 0
      ? parsedState
      : mergeClientWorkspaceStateIntoServerState(current.state, parsedState);

    const nextEnvelope: WorkspaceEnvelope = {
      version: current.version + 1,
      updatedAt: createTimestamp(),
      state: mergedState,
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
