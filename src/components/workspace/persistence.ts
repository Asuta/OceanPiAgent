import type { RoomWorkspaceState } from "@/lib/chat/types";

export const STORAGE_KEY = "oceanking.room-shell.v4";
export const PREVIOUS_STORAGE_KEY = "oceanking.room-shell.v3";
export const LEGACY_STORAGE_KEY = "oceanking.room-shell.v1";

export interface WorkspaceEnvelope {
  version?: number;
  state?: RoomWorkspaceState;
}

export function loadLocalWorkspaceState(args: {
  parseWorkspaceState: (raw: string) => RoomWorkspaceState | null;
  migrateLegacyWorkspaceState: (raw: string) => RoomWorkspaceState | null;
}): RoomWorkspaceState | null {
  try {
    const persisted = localStorage.getItem(STORAGE_KEY);
    const parsedWorkspace = persisted ? args.parseWorkspaceState(persisted) : null;
    if (parsedWorkspace) {
      return parsedWorkspace;
    }

    const previousPersisted = localStorage.getItem(PREVIOUS_STORAGE_KEY);
    const previousWorkspace = previousPersisted ? args.parseWorkspaceState(previousPersisted) : null;
    if (previousWorkspace) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(previousWorkspace));
      localStorage.removeItem(PREVIOUS_STORAGE_KEY);
      return previousWorkspace;
    }

    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    const migratedWorkspace = legacy ? args.migrateLegacyWorkspaceState(legacy) : null;
    if (migratedWorkspace) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migratedWorkspace));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return migratedWorkspace;
    }
  } catch {
    clearPersistedWorkspaceState();
  }

  return null;
}

export function saveWorkspaceStateToLocalStorage(state: RoomWorkspaceState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clearPersistedWorkspaceState(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(PREVIOUS_STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
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
