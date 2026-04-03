import type { RoomWorkspaceState } from "@/lib/chat/types";
import {
  buildBrowserWorkspaceCacheRecord,
  buildWorkspaceBootstrapState,
  type BrowserWorkspaceCacheRecord,
  type WorkspaceBootstrap,
} from "@/components/workspace/browser-workspace-cache";

export const WORKSPACE_BOOTSTRAP_STORAGE_KEY = "oceanking.room-shell.bootstrap.v1";
export const LEGACY_STORAGE_KEY = "oceanking.room-shell.v4";
export const PREVIOUS_STORAGE_KEY = "oceanking.room-shell.v3";
export const LEGACY_V1_STORAGE_KEY = "oceanking.room-shell.v1";

const WORKSPACE_CACHE_DB_NAME = "oceanking-room-shell";
const WORKSPACE_CACHE_DB_VERSION = 1;
const WORKSPACE_CACHE_STORE_NAME = "workspace-cache";
const WORKSPACE_CACHE_RECORD_KEY = "workspace";

export interface WorkspaceEnvelope {
  version?: number;
  state?: RoomWorkspaceState;
}

export interface RoomCommandResponse {
  ok?: boolean;
  envelope?: WorkspaceEnvelope;
  roomId?: string | null;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clearLegacyPersistedWorkspaceState(): void {
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  localStorage.removeItem(PREVIOUS_STORAGE_KEY);
  localStorage.removeItem(LEGACY_V1_STORAGE_KEY);
}

function clearWorkspaceBootstrapStorage(): void {
  localStorage.removeItem(WORKSPACE_BOOTSTRAP_STORAGE_KEY);
}

async function openWorkspaceCacheDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return null;
  }

  return new Promise((resolve) => {
    const request = indexedDB.open(WORKSPACE_CACHE_DB_NAME, WORKSPACE_CACHE_DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(WORKSPACE_CACHE_STORE_NAME)) {
        database.createObjectStore(WORKSPACE_CACHE_STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function readWorkspaceCacheRecord(): Promise<BrowserWorkspaceCacheRecord | null> {
  const database = await openWorkspaceCacheDatabase();
  if (!database) {
    return null;
  }

  try {
    return await new Promise((resolve) => {
      const transaction = database.transaction(WORKSPACE_CACHE_STORE_NAME, "readonly");
      const request = transaction.objectStore(WORKSPACE_CACHE_STORE_NAME).get(WORKSPACE_CACHE_RECORD_KEY);
      request.onsuccess = () => resolve((request.result as BrowserWorkspaceCacheRecord | undefined) ?? null);
      request.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
    });
  } finally {
    database.close();
  }
}

async function writeWorkspaceCacheRecord(record: BrowserWorkspaceCacheRecord): Promise<void> {
  const database = await openWorkspaceCacheDatabase();
  if (!database) {
    return;
  }

  try {
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(WORKSPACE_CACHE_STORE_NAME, "readwrite");
      transaction.objectStore(WORKSPACE_CACHE_STORE_NAME).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  } finally {
    database.close();
  }
}

async function clearWorkspaceCacheRecord(): Promise<void> {
  const database = await openWorkspaceCacheDatabase();
  if (!database) {
    return;
  }

  try {
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(WORKSPACE_CACHE_STORE_NAME, "readwrite");
      transaction.objectStore(WORKSPACE_CACHE_STORE_NAME).delete(WORKSPACE_CACHE_RECORD_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  } finally {
    database.close();
  }
}

function loadLegacyLocalWorkspaceState(args: {
  parseWorkspaceState: (raw: string) => RoomWorkspaceState | null;
  migrateLegacyWorkspaceState: (raw: string) => RoomWorkspaceState | null;
}): RoomWorkspaceState | null {
  try {
    const persisted = localStorage.getItem(LEGACY_STORAGE_KEY);
    const parsedWorkspace = persisted ? args.parseWorkspaceState(persisted) : null;
    if (parsedWorkspace) {
      return parsedWorkspace;
    }

    const previousPersisted = localStorage.getItem(PREVIOUS_STORAGE_KEY);
    const previousWorkspace = previousPersisted ? args.parseWorkspaceState(previousPersisted) : null;
    if (previousWorkspace) {
      return previousWorkspace;
    }

    const legacy = localStorage.getItem(LEGACY_V1_STORAGE_KEY);
    const migratedWorkspace = legacy ? args.migrateLegacyWorkspaceState(legacy) : null;
    if (migratedWorkspace) {
      return migratedWorkspace;
    }
  } catch {
    clearLegacyPersistedWorkspaceState();
  }

  return null;
}

export function loadWorkspaceBootstrapFromLocalStorage(): WorkspaceBootstrap | null {
  try {
    const persisted = localStorage.getItem(WORKSPACE_BOOTSTRAP_STORAGE_KEY);
    if (!persisted) {
      return null;
    }

    const parsed = JSON.parse(persisted) as unknown;
    if (!isRecord(parsed) || typeof parsed.activeRoomId !== "string" || !parsed.activeRoomId) {
      clearWorkspaceBootstrapStorage();
      return null;
    }

    return {
      version: 1,
      activeRoomId: parsed.activeRoomId,
      ...(typeof parsed.selectedConsoleAgentId === "string" && parsed.selectedConsoleAgentId
        ? { selectedConsoleAgentId: parsed.selectedConsoleAgentId }
        : {}),
      savedAt: typeof parsed.savedAt === "string" && parsed.savedAt ? parsed.savedAt : new Date().toISOString(),
    };
  } catch {
    clearWorkspaceBootstrapStorage();
    return null;
  }
}

export function saveWorkspaceBootstrapToLocalStorage(state: RoomWorkspaceState): void {
  const serializedState = JSON.stringify(buildWorkspaceBootstrapState(state));

  try {
    localStorage.setItem(WORKSPACE_BOOTSTRAP_STORAGE_KEY, serializedState);
  } catch {
    clearLegacyPersistedWorkspaceState();

    try {
      localStorage.setItem(WORKSPACE_BOOTSTRAP_STORAGE_KEY, serializedState);
    } catch {
      clearWorkspaceBootstrapStorage();
    }
  }
}

export async function loadBrowserWorkspaceState(args: {
  parseWorkspaceState: (raw: string) => RoomWorkspaceState | null;
  migrateLegacyWorkspaceState: (raw: string) => RoomWorkspaceState | null;
}): Promise<RoomWorkspaceState | null> {
  try {
    const cachedRecord = await readWorkspaceCacheRecord();
    const cachedState = cachedRecord?.state ? args.parseWorkspaceState(JSON.stringify(cachedRecord.state)) : null;
    if (cachedState) {
      clearLegacyPersistedWorkspaceState();
      return cachedState;
    }
  } catch {
    // Ignore IndexedDB failures and continue with legacy migration fallback.
  }

  const legacyState = loadLegacyLocalWorkspaceState(args);
  if (!legacyState) {
    clearLegacyPersistedWorkspaceState();
    return null;
  }

  saveWorkspaceBootstrapToLocalStorage(legacyState);
  await saveWorkspaceStateToIndexedDb(legacyState);
  clearLegacyPersistedWorkspaceState();
  return legacyState;
}

export async function saveWorkspaceStateToIndexedDb(state: RoomWorkspaceState): Promise<void> {
  try {
    await writeWorkspaceCacheRecord(buildBrowserWorkspaceCacheRecord(state));
  } catch {
    // Ignore browser cache write failures and rely on server persistence.
  }
}

export async function clearPersistedWorkspaceState(): Promise<void> {
  clearWorkspaceBootstrapStorage();
  clearLegacyPersistedWorkspaceState();
  await clearWorkspaceCacheRecord();
}

export async function fetchWorkspaceEnvelope(): Promise<WorkspaceEnvelope | null> {
  const response = await fetch("/api/workspace", { cache: "no-store" }).catch(() => null);
  if (!response?.ok) {
    return null;
  }

  return (await response.json().catch(() => null)) as WorkspaceEnvelope | null;
}

export async function saveWorkspaceEnvelope(args: {
  expectedVersion: number;
  state: RoomWorkspaceState;
}): Promise<Response | null> {
  return fetch("/api/workspace", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expectedVersion: args.expectedVersion,
      state: args.state,
    }),
  }).catch(() => null);
}

export async function postRoomCommand(payload: unknown): Promise<RoomCommandResponse | null> {
  const response = await fetch("/api/rooms/command", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }).catch(() => null);
  return (await response?.json().catch(() => null)) as RoomCommandResponse | null;
}
