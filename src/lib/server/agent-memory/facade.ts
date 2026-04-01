import type { MemoryBackendId } from "@/lib/chat/types";
import { loadWorkspaceEnvelope } from "@/lib/server/workspace-store";
import { MarkdownMemoryBackend } from "./backends/markdown-backend";
import type { AgentMemoryBackend } from "./backend";
import type {
  AgentMemoryIndexResult,
  AgentMemorySearchOptions,
  MemoryDescribeResult,
  MemoryExpandResult,
  AgentMemoryStatus,
  AppendAgentCompactionMemoryArgs,
  AppendAgentTurnMemoryArgs,
  MemoryFileSlice,
  MemorySearchResult,
  ReadAgentMemoryFileArgs,
} from "./types";
import type { RoomAgentId } from "@/lib/chat/types";
import { getAgentLcmRetrieval } from "../lcm/facade";
import { estimateTokens } from "../lcm/estimate-tokens";

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
  const { conversation, retrieval } = await getAgentLcmRetrieval(agentId);
  if (conversation) {
    const grep = await retrieval.grep({
      query,
      mode: "full_text",
      scope: "both",
      conversationId: conversation.conversationId,
      limit: options?.maxResults,
    });
    const structured = [
      ...grep.messages.map((message) => ({
        handle: `message:${message.messageId}`,
        type: "message" as const,
        id: String(message.messageId),
        path: `message:${message.messageId}`,
        startLine: 1,
        endLine: 1,
        snippet: message.snippet,
        score: message.rank ?? 0,
        createdAt: message.createdAt.toISOString(),
      })),
      ...grep.summaries.map((summary) => ({
        handle: `summary:${summary.summaryId}`,
        type: "summary" as const,
        id: summary.summaryId,
        path: `summary:${summary.summaryId}`,
        startLine: 1,
        endLine: 1,
        snippet: summary.snippet,
        score: summary.rank ?? 0,
        createdAt: summary.createdAt.toISOString(),
      })),
    ].slice(0, options?.maxResults ?? 8);
    if (structured.length > 0) {
      return structured;
    }
  }

  const resolved = await getResolvedBackend(agentId, options?.backendId);
  return resolved.backend.search(agentId, query, options);
}

export async function readAgentMemoryFile(args: ReadAgentMemoryFileArgs, options?: { backendId?: MemoryBackendId }): Promise<MemoryFileSlice> {
  const resolved = await getResolvedBackend(args.agentId, options?.backendId);
  return resolved.backend.readFile(args);
}

export async function describeAgentMemory(agentId: RoomAgentId, handle: string): Promise<MemoryDescribeResult | null> {
  if (handle.startsWith("summary:")) {
    const { retrieval } = await getAgentLcmRetrieval(agentId);
    const described = await retrieval.describe(handle.slice("summary:".length));
    if (!described?.summary) {
      return null;
    }
    return {
      handle,
      type: "summary",
      summary: {
        summaryId: described.summary.kind ? described.id : described.id,
        kind: described.summary.kind,
        depth: described.summary.depth,
        content: described.summary.content,
        createdAt: described.summary.createdAt.toISOString(),
        tokenCount: described.summary.tokenCount,
        parentIds: described.summary.parentIds,
        childIds: described.summary.childIds,
        messageIds: described.summary.messageIds,
      },
    };
  }
  if (handle.startsWith("message:")) {
    const { conversation, retrieval } = await getAgentLcmRetrieval(agentId);
    if (!conversation) return null;
    const messageId = Number(handle.slice("message:".length));
    const grep = await retrieval.grep({ query: String(messageId), mode: "full_text", scope: "messages", conversationId: conversation.conversationId, limit: 200 });
    const match = grep.messages.find((message) => message.messageId === messageId);
    if (!match) {
      return null;
    }
    return {
      handle,
      type: "message",
      message: {
        messageId,
        role: match.role,
        content: match.snippet,
        createdAt: match.createdAt.toISOString(),
      },
    };
  }
  const slice = await readAgentMemoryFile({ agentId, relPath: handle.startsWith("file:") ? handle.slice("file:".length) : handle, lines: 40 }).catch(() => null);
  if (!slice) return null;
  return { handle: handle.startsWith("file:") ? handle : `file:${slice.path}`, type: "file", file: slice };
}

export async function expandAgentMemory(
  agentId: RoomAgentId,
  args: { handle: string; depth?: number; includeMessages?: boolean; maxItems?: number },
): Promise<MemoryExpandResult | null> {
  if (args.handle.startsWith("summary:")) {
    const { retrieval } = await getAgentLcmRetrieval(agentId);
    const expanded = await retrieval.expand({
      summaryId: args.handle.slice("summary:".length),
      depth: args.depth,
      includeMessages: args.includeMessages,
      tokenCap: typeof args.maxItems === "number" ? args.maxItems * 300 : undefined,
    });
    return {
      handle: args.handle,
      type: "summary",
      summaries: expanded.children,
      messages: expanded.messages.map((message) => ({ ...message, createdAt: undefined })),
      estimatedTokens: expanded.estimatedTokens,
      truncated: expanded.truncated,
    };
  }
  if (args.handle.startsWith("message:")) {
    const description = await describeAgentMemory(agentId, args.handle);
    if (!description?.message) return null;
    return {
      handle: args.handle,
      type: "message",
      summaries: [],
      messages: [{ ...description.message, tokenCount: estimateTokens(description.message.content) }],
      estimatedTokens: estimateTokens(description.message.content),
      truncated: false,
    };
  }
  const file = await readAgentMemoryFile({ agentId, relPath: args.handle.startsWith("file:") ? args.handle.slice("file:".length) : args.handle, lines: 60 }).catch(() => null);
  if (!file) return null;
  return {
    handle: args.handle.startsWith("file:") ? args.handle : `file:${file.path}`,
    type: "file",
    summaries: [],
    messages: [{ messageId: file.path, role: "file", content: file.text, tokenCount: estimateTokens(file.text) }],
    estimatedTokens: estimateTokens(file.text),
    truncated: false,
  };
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
