import type { MemoryBackendId } from "@/lib/chat/types";
import { loadWorkspaceEnvelope } from "@/lib/server/workspace-store";
import { MarkdownMemoryBackend } from "./backends/markdown-backend";
import type { AgentMemoryBackend } from "./backend";
import type {
  AgentMemoryIndexResult,
  AgentMemorySearchOptions,
  AgentMemoryStatus,
  AppendAgentCompactionMemoryArgs,
  AppendAgentTurnMemoryArgs,
  MemoryFileSlice,
  MemorySearchResult,
  ReadAgentMemoryFileArgs,
} from "./types";
import type { RoomAgentId } from "@/lib/chat/types";

type ResolvedMemoryBackend = {
  requestedId: MemoryBackendId;
  backend: AgentMemoryBackend;
  fallbackReason?: string;
};

const cachedBackends = new Map<MemoryBackendId, ResolvedMemoryBackend>();

function normalizeBackendId(value: unknown): MemoryBackendId {
  return value === "markdown" ? "markdown" : "sqlite-fts";
}

function getConfiguredBackendId(): MemoryBackendId {
  return process.env.OCEANKING_MEMORY_BACKEND === "markdown" ? "markdown" : "sqlite-fts";
}

async function createBackend(requestedId: MemoryBackendId): Promise<ResolvedMemoryBackend> {
  if (requestedId === "markdown") {
    return {
      requestedId,
      backend: new MarkdownMemoryBackend(),
    };
  }

  try {
    const { SqliteFtsMemoryBackend } = await import("./backends/sqlite-fts-backend");
    return {
      requestedId,
      backend: new SqliteFtsMemoryBackend(),
    };
  } catch (error) {
    return {
      requestedId,
      backend: new MarkdownMemoryBackend(),
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveRequestedBackendId(agentId: RoomAgentId, override?: MemoryBackendId): Promise<MemoryBackendId> {
  if (override) {
    return normalizeBackendId(override);
  }

  try {
    const workspace = await loadWorkspaceEnvelope();
    return normalizeBackendId(workspace.state.agentStates[agentId]?.settings?.memoryBackend);
  } catch {
    return getConfiguredBackendId();
  }
}

async function getResolvedBackend(agentId: RoomAgentId, override?: MemoryBackendId): Promise<ResolvedMemoryBackend> {
  const requestedId = await resolveRequestedBackendId(agentId, override);
  const cached = cachedBackends.get(requestedId);
  if (cached) {
    return cached;
  }

  const resolved = await createBackend(requestedId);
  cachedBackends.set(requestedId, resolved);
  return resolved;
}

function withFallbackReason<T extends { fallbackReason?: string }>(value: T, fallbackReason?: string): T {
  if (!fallbackReason) {
    return value;
  }

  return {
    ...value,
    fallbackReason,
  };
}

export async function appendAgentTurnMemory(args: AppendAgentTurnMemoryArgs, options?: { backendId?: MemoryBackendId }): Promise<void> {
  const resolved = await getResolvedBackend(args.agentId, options?.backendId);
  await resolved.backend.appendTurnMemory(args);
}

export async function appendAgentCompactionMemory(args: AppendAgentCompactionMemoryArgs, options?: { backendId?: MemoryBackendId }): Promise<void> {
  const resolved = await getResolvedBackend(args.agentId, options?.backendId);
  await resolved.backend.appendCompactionMemory(args);
}

export async function searchAgentMemory(
  agentId: RoomAgentId,
  query: string,
  options?: AgentMemorySearchOptions & { backendId?: MemoryBackendId },
): Promise<MemorySearchResult[]> {
  const resolved = await getResolvedBackend(agentId, options?.backendId);
  return resolved.backend.search(agentId, query, options);
}

export async function readAgentMemoryFile(args: ReadAgentMemoryFileArgs, options?: { backendId?: MemoryBackendId }): Promise<MemoryFileSlice> {
  const resolved = await getResolvedBackend(args.agentId, options?.backendId);
  return resolved.backend.readFile(args);
}

export async function clearAgentMemory(agentId: RoomAgentId, options?: { backendId?: MemoryBackendId }): Promise<void> {
  const resolved = await getResolvedBackend(agentId, options?.backendId);
  await resolved.backend.clear(agentId);
}

export async function getAgentMemorySummary(agentId: RoomAgentId, options?: { backendId?: MemoryBackendId }) {
  const resolved = await getResolvedBackend(agentId, options?.backendId);
  return resolved.backend.getSummary(agentId);
}

export async function getAgentMemoryStatus(agentId: RoomAgentId, options?: { backendId?: MemoryBackendId }): Promise<AgentMemoryStatus> {
  const resolved = await getResolvedBackend(agentId, options?.backendId);
  const status = await resolved.backend.getStatus(agentId);
  return withFallbackReason(status, resolved.fallbackReason);
}

export async function reindexAgentMemory(
  agentId: RoomAgentId,
  options?: { force?: boolean; backendId?: MemoryBackendId },
): Promise<AgentMemoryIndexResult> {
  const resolved = await getResolvedBackend(agentId, options?.backendId);
  const result = await resolved.backend.reindex(agentId, options);
  return withFallbackReason(result, resolved.fallbackReason);
}
