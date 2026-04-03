import { rm } from "node:fs/promises";
import path from "node:path";
import type { MemoryBackendId, RoomAgentId } from "@/lib/chat/types";
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
import { getAgentLcmRetrieval, getLcmStores } from "../lcm/facade";
import { extractSearchTerms } from "../lcm/full-text-fallback";
import { estimateTokens } from "../lcm/estimate-tokens";

const LEGACY_FALLBACK_REASON =
  "Legacy markdown memory has been removed; OceanKing now always uses structured LCM memory.";

function getLegacyFallbackReason(backendId?: MemoryBackendId): string | undefined {
  return backendId === "markdown" || process.env.OCEANKING_MEMORY_BACKEND === "markdown"
    ? LEGACY_FALLBACK_REASON
    : undefined;
}

function withFallbackReason<T extends object>(value: T, backendId?: MemoryBackendId): T & { fallbackReason?: string } {
  const fallbackReason = getLegacyFallbackReason(backendId);
  if (!fallbackReason) {
    return value;
  }

  return {
    ...value,
    fallbackReason,
  };
}

async function getStructuredMemoryStats(agentId: RoomAgentId) {
  const { conversationStore, summaryStore } = await getLcmStores();
  const conversation = await conversationStore.getConversationBySessionKey(agentId);
  if (!conversation) {
    return {
      conversation,
      messageCount: 0,
      summaryCount: 0,
      largeFileCount: 0,
      contextItemCount: 0,
    };
  }

  const [messageCount, summaries, largeFiles, contextItems] = await Promise.all([
    conversationStore.getMessageCount(conversation.conversationId),
    summaryStore.getSummariesByConversation(conversation.conversationId),
    summaryStore.getLargeFilesByConversation(conversation.conversationId),
    summaryStore.getContextItems(conversation.conversationId),
  ]);

  return {
    conversation,
    messageCount,
    summaryCount: summaries.length,
    largeFileCount: largeFiles.length,
    contextItemCount: contextItems.length,
  };
}

export async function appendAgentTurnMemory(
  args: AppendAgentTurnMemoryArgs,
  options?: { backendId?: MemoryBackendId },
): Promise<void> {
  void args;
  void options;
  // Legacy markdown timeline writes were removed. LCM ingestion is handled elsewhere.
}

export async function appendAgentCompactionMemory(
  args: AppendAgentCompactionMemoryArgs,
  options?: { backendId?: MemoryBackendId },
): Promise<void> {
  void args;
  void options;
  // Legacy compaction markdown writes were removed. Summary lineage now lives in LCM.
}

export async function searchAgentMemory(
  agentId: RoomAgentId,
  query: string,
  options?: AgentMemorySearchOptions & { backendId?: MemoryBackendId },
): Promise<MemorySearchResult[]> {
  const { conversation, retrieval } = await getAgentLcmRetrieval(agentId);
  if (!conversation) {
    return [];
  }

  const limit = options?.maxResults ?? 8;
  const queryTerms = extractSearchTerms(query);

  const mapGrepResult = (grep: Awaited<ReturnType<typeof retrieval.grep>>, matchedTerms: string[]): MemorySearchResult[] => [
    ...grep.messages.map((message) => ({
      handle: `message:${message.messageId}`,
      type: "message" as const,
      id: String(message.messageId),
      path: `message:${message.messageId}`,
      startLine: 1,
      endLine: 1,
      snippet: message.snippet,
      score: Math.max(1, matchedTerms.filter((term) => message.snippet.toLowerCase().includes(term)).length),
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
      score: Math.max(1, matchedTerms.filter((term) => summary.snippet.toLowerCase().includes(term)).length),
      createdAt: summary.createdAt.toISOString(),
    })),
  ];

  const grep = await retrieval.grep({
    query,
    mode: "full_text",
    scope: "both",
    conversationId: conversation.conversationId,
    limit,
  });

  let results = mapGrepResult(grep, queryTerms.length > 0 ? queryTerms : [query.toLowerCase()]);

  if (results.length === 0 && queryTerms.length > 1) {
    const merged = new Map<string, MemorySearchResult & { matchedTerms: Set<string> }>();
    for (const term of queryTerms.slice(0, 6)) {
      const termGrep = await retrieval.grep({
        query: term,
        mode: "full_text",
        scope: "both",
        conversationId: conversation.conversationId,
        limit,
      });

      for (const result of mapGrepResult(termGrep, [term])) {
        const key = result.handle ?? result.path;
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, {
            ...result,
            matchedTerms: new Set([term]),
          });
          continue;
        }

        existing.matchedTerms.add(term);
        existing.score = existing.matchedTerms.size;
        if (Date.parse(result.createdAt ?? "") > Date.parse(existing.createdAt ?? "")) {
          existing.createdAt = result.createdAt;
        }
        if ((result.snippet?.length ?? 0) > (existing.snippet?.length ?? 0)) {
          existing.snippet = result.snippet;
        }
      }
    }

    results = [...merged.values()]
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? "");
      })
      .map((result) => ({
        handle: result.handle,
        type: result.type,
        id: result.id,
        path: result.path,
        startLine: result.startLine,
        endLine: result.endLine,
        snippet: result.snippet,
        score: result.score,
        createdAt: result.createdAt,
      }));
  }

  const minScore = options?.minScore ?? 0;
  return results.filter((result) => result.score >= minScore).slice(0, limit);
}

export async function readAgentMemoryFile(
  args: ReadAgentMemoryFileArgs,
  options?: { backendId?: MemoryBackendId },
): Promise<MemoryFileSlice> {
  void args;
  void options;
  throw new Error("Legacy markdown memory files are no longer available. Use memory_search and memory_get with structured handles.");
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
        summaryId: described.id,
        kind: described.summary.kind,
        depth: described.summary.depth,
        content: described.summary.content,
        createdAt: described.summary.createdAt.toISOString(),
        tokenCount: described.summary.tokenCount,
        parentIds: described.summary.parentIds,
        childIds: described.summary.childIds,
        messageIds: described.summary.messageIds,
        descendantCount: described.summary.descendantCount,
        descendantTokenCount: described.summary.descendantTokenCount,
        sourceMessageTokenCount: described.summary.sourceMessageTokenCount,
        fileIds: described.summary.fileIds,
        subtree: described.summary.subtree.map((node) => ({
          ...node,
          earliestAt: node.earliestAt?.toISOString() ?? null,
          latestAt: node.latestAt?.toISOString() ?? null,
        })),
      },
    };
  }

  if (handle.startsWith("file:")) {
    const { retrieval } = await getAgentLcmRetrieval(agentId);
    const described = await retrieval.describe(handle.slice("file:".length));
    if (!described?.file) {
      return null;
    }
    return {
      handle,
      type: "file",
      file: {
        path: handle,
        from: 1,
        lines: 1,
        text: described.file.explorationSummary ?? "",
        fileId: described.id,
        mimeType: described.file.mimeType,
        byteSize: described.file.byteSize,
        storageUri: described.file.storageUri,
        explorationSummary: described.file.explorationSummary,
        createdAt: described.file.createdAt.toISOString(),
      },
    };
  }

  if (handle.startsWith("message:")) {
    const messageId = Number(handle.slice("message:".length));
    if (!Number.isFinite(messageId)) {
      return null;
    }
    const { conversationStore } = await getLcmStores();
    const message = await conversationStore.getMessageById(messageId);
    if (!message) {
      return null;
    }
    return {
      handle,
      type: "message",
      message: {
        messageId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      },
    };
  }

  return null;
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
    if (!description?.message) {
      return null;
    }
    return {
      handle: args.handle,
      type: "message",
      summaries: [],
      messages: [{ ...description.message, tokenCount: estimateTokens(description.message.content) }],
      estimatedTokens: estimateTokens(description.message.content),
      truncated: false,
    };
  }

  if (args.handle.startsWith("file:")) {
    const description = await describeAgentMemory(agentId, args.handle);
    if (!description?.file) {
      return null;
    }
    return {
      handle: args.handle,
      type: "file",
      summaries: [],
      messages: [{
        messageId: description.file.fileId ?? description.file.path,
        role: "file",
        content: description.file.text,
        tokenCount: estimateTokens(description.file.text),
        createdAt: description.file.createdAt,
      }],
      estimatedTokens: estimateTokens(description.file.text),
      truncated: false,
    };
  }

  return null;
}

export async function clearAgentMemory(
  agentId: RoomAgentId,
  options?: { backendId?: MemoryBackendId },
): Promise<void> {
  void options;
  await Promise.all([
    rm(path.join(process.cwd(), ".oceanking", "memory", agentId), { recursive: true, force: true }),
    rm(path.join(process.cwd(), ".oceanking", "memory-index", `${agentId}.sqlite`), { force: true }),
  ]);
}

export async function getAgentMemorySummary(agentId: RoomAgentId, options?: { backendId?: MemoryBackendId }) {
  const stats = await getStructuredMemoryStats(agentId);
  return withFallbackReason(
    {
      fileCount: stats.largeFileCount,
      hasTimeline: stats.messageCount > 0,
      hasCompactions: stats.summaryCount > 0,
    },
    options?.backendId,
  );
}

export async function getAgentMemoryStatus(
  agentId: RoomAgentId,
  options?: { backendId?: MemoryBackendId },
): Promise<AgentMemoryStatus> {
  const stats = await getStructuredMemoryStats(agentId);
  return withFallbackReason(
    {
      backend: "sqlite-fts",
      fileCount: stats.largeFileCount,
      hasTimeline: stats.messageCount > 0,
      hasCompactions: stats.summaryCount > 0,
      documentCount: stats.messageCount + stats.summaryCount + stats.largeFileCount,
      chunkCount: stats.contextItemCount,
      lastIndexedAt: stats.conversation?.updatedAt.toISOString(),
      dirty: false,
      missingIndex: false,
    },
    options?.backendId,
  );
}

export async function reindexAgentMemory(
  agentId: RoomAgentId,
  options?: { force?: boolean; backendId?: MemoryBackendId },
): Promise<AgentMemoryIndexResult> {
  const startedAt = performance.now();
  const stats = await getStructuredMemoryStats(agentId);
  return withFallbackReason(
    {
      backend: "sqlite-fts",
      mode: options?.force ? "full" : "incremental",
      indexedDocuments: stats.messageCount + stats.summaryCount + stats.largeFileCount,
      removedDocuments: 0,
      chunkCount: stats.contextItemCount,
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    },
    options?.backendId,
  );
}
