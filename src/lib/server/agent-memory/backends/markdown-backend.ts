import type { RoomAgentId } from "@/lib/chat/types";
import type { AgentMemoryBackend } from "../backend";
import {
  appendAgentCompactionMemoryFile,
  appendAgentTurnMemoryFile,
  buildSearchChunks,
  clearAgentMemorySource,
  collectMemorySourceDocuments,
  getAgentMemorySummarySource,
  orderFilesForSearch,
  readAgentMemoryFileSource,
  tokenize,
  toLinePreview,
} from "../source";
import type {
  AgentMemoryIndexResult,
  AgentMemorySearchOptions,
  AgentMemoryStatus,
  AppendAgentCompactionMemoryArgs,
  AppendAgentTurnMemoryArgs,
  MemoryFileSlice,
  MemorySearchResult,
  ReadAgentMemoryFileArgs,
} from "../types";

function countQueryOverlap(tokens: Set<string>, value: string): number {
  return tokenize(value).reduce((count, token) => count + (tokens.has(token) ? 1 : 0), 0);
}

export class MarkdownMemoryBackend implements AgentMemoryBackend {
  readonly id: AgentMemoryBackend["id"] = "markdown";

  async appendTurnMemory(args: AppendAgentTurnMemoryArgs): Promise<void> {
    await appendAgentTurnMemoryFile(args);
  }

  async appendCompactionMemory(args: AppendAgentCompactionMemoryArgs): Promise<void> {
    await appendAgentCompactionMemoryFile(args);
  }

  async search(agentId: RoomAgentId, query: string, options?: AgentMemorySearchOptions): Promise<MemorySearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const documents = await collectMemorySourceDocuments(agentId);
    if (documents.length === 0) {
      return [];
    }

    const orderedFiles = orderFilesForSearch(documents);
    const timelineFileCount = documents.filter((file) => file.kind === "timeline").length;
    const nonTimelineFileCount = orderedFiles.filter((file) => file.kind !== "timeline").length;
    const olderTimelineStartIndex = Math.min(
      orderedFiles.length,
      Math.min(timelineFileCount, 3) + nonTimelineFileCount,
    );

    const queryTokens = new Set(tokenize(normalizedQuery));
    const maxResults = typeof options?.maxResults === "number" && Number.isFinite(options.maxResults)
      ? Math.max(1, Math.min(20, Math.round(options.maxResults)))
      : 8;
    const minScore = typeof options?.minScore === "number" && Number.isFinite(options.minScore)
      ? options.minScore
      : 0;
    const queryLower = normalizedQuery.toLowerCase();
    const results: MemorySearchResult[] = [];
    const resultOrder = new Map<string, number>();

    for (let fileIndex = 0; fileIndex < orderedFiles.length; fileIndex += 1) {
      if (fileIndex >= olderTimelineStartIndex && results.length >= maxResults) {
        break;
      }

      const file = orderedFiles[fileIndex];
      if (!file.text.trim()) {
        continue;
      }

      const lines = file.text.split(/\r?\n/g);
      const chunks = buildSearchChunks(file.text);
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex];
        const overlap = countQueryOverlap(queryTokens, chunk.text);
        const substringBoost = chunk.text.toLowerCase().includes(queryLower) ? 2 : 0;
        const headingBoost = lines[chunk.startLine - 1]?.startsWith("## ") ? 1 : 0;
        const matchScore = overlap + substringBoost;
        if (matchScore <= 0) {
          continue;
        }

        const score = matchScore + headingBoost;
        if (score < minScore) {
          continue;
        }

        results.push({
          path: file.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          snippet: toLinePreview(lines, chunk.startLine - 1, chunk.endLine),
          score,
        });
        resultOrder.set(`${file.path}:${chunk.startLine}:${chunk.endLine}`, file.searchOrder);
      }
    }

    return results
      .sort(
        (left, right) =>
          right.score - left.score
          || (resultOrder.get(`${left.path}:${left.startLine}:${left.endLine}`) ?? Number.MAX_SAFE_INTEGER)
            - (resultOrder.get(`${right.path}:${right.startLine}:${right.endLine}`) ?? Number.MAX_SAFE_INTEGER)
          || left.path.localeCompare(right.path)
          || left.startLine - right.startLine,
      )
      .slice(0, maxResults);
  }

  async readFile(args: ReadAgentMemoryFileArgs): Promise<MemoryFileSlice> {
    return readAgentMemoryFileSource(args);
  }

  async clear(agentId: RoomAgentId): Promise<void> {
    await clearAgentMemorySource(agentId);
  }

  async getSummary(agentId: RoomAgentId) {
    return getAgentMemorySummarySource(agentId);
  }

  async getStatus(agentId: RoomAgentId): Promise<AgentMemoryStatus> {
    const summary = await getAgentMemorySummarySource(agentId);
    const documents = await collectMemorySourceDocuments(agentId);
    const chunkCount = documents.reduce((total, document) => total + buildSearchChunks(document.text).length, 0);
    return {
      ...summary,
      backend: this.id,
      documentCount: documents.length,
      chunkCount,
      dirty: false,
      missingIndex: false,
    };
  }

  async reindex(agentId: RoomAgentId): Promise<AgentMemoryIndexResult> {
    const startedAt = performance.now();
    const documents = await collectMemorySourceDocuments(agentId);
    const chunkCount = documents.reduce((total, document) => total + buildSearchChunks(document.text).length, 0);
    return {
      backend: this.id,
      mode: "full",
      indexedDocuments: documents.length,
      removedDocuments: 0,
      chunkCount,
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    };
  }
}
