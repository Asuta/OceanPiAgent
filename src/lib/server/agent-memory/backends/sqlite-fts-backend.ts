import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { RoomAgentId } from "@/lib/chat/types";
import type { AgentMemoryBackend } from "../backend";
import {
  appendAgentCompactionMemoryFile,
  appendAgentTurnMemoryFile,
  buildSearchChunks,
  clearAgentMemorySource,
  collectMemorySourceDocuments,
  createTimestamp,
  ensureMemoryIndexDir,
  getAgentMemorySummarySource,
  getMemoryIndexPath,
  orderFilesForSearch,
  readAgentMemoryFileSource,
  tokenize,
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
import { MarkdownMemoryBackend } from "./markdown-backend";

type IndexedDocumentRow = {
  id: number;
  path: string;
  checksum: string;
};

type SearchCandidateRow = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  sortOrder: number;
  chunkIndex: number;
  rank: number;
};

function formatChunkPreview(text: string, startLine: number): string {
  return text
    .split(/\r?\n/g)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join("\n")
    .trim();
}

function countQueryOverlap(tokens: Set<string>, value: string): number {
  return tokenize(value).reduce((count, token) => count + (tokens.has(token) ? 1 : 0), 0);
}

function buildMatchQuery(query: string): string | null {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return null;
  }

  return tokens.map((token) => `${token}*`).join(" OR ");
}

function openDatabase(agentId: RoomAgentId): DatabaseSync {
  const database = new DatabaseSync(getMemoryIndexPath(agentId));
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      shard_key TEXT NOT NULL,
      checksum TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      shard_key TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, tokenize='unicode61');
  `);
  return database;
}

function getMetadata(database: DatabaseSync, key: string): string | undefined {
  const row = database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function setMetadata(database: DatabaseSync, key: string, value: string): void {
  database.prepare(`
    INSERT INTO metadata(key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function listIndexedDocuments(database: DatabaseSync): IndexedDocumentRow[] {
  return database.prepare("SELECT id, path, checksum FROM documents ORDER BY path").all() as IndexedDocumentRow[];
}

function deleteDocumentChunks(database: DatabaseSync, documentId: number): void {
  const chunkIds = database.prepare("SELECT id FROM chunks WHERE document_id = ?").all(documentId) as Array<{ id: number }>;
  for (const chunk of chunkIds) {
    database.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(chunk.id);
  }
  database.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
}

function removeDocument(database: DatabaseSync, documentId: number): void {
  deleteDocumentChunks(database, documentId);
  database.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
}

function countChunks(database: DatabaseSync): number {
  const row = database.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number };
  return row?.count ?? 0;
}

function syncIndex(
  database: DatabaseSync,
  documents: Awaited<ReturnType<typeof collectMemorySourceDocuments>>,
  force = false,
): { indexedDocuments: number; removedDocuments: number; chunkCount: number } {
  const orderedDocuments = orderFilesForSearch(documents);
  const existingDocuments = new Map(listIndexedDocuments(database).map((document) => [document.path, document]));
  const seenPaths = new Set<string>();
  let indexedDocuments = 0;

  for (const document of orderedDocuments) {
    seenPaths.add(document.path);
    const existing = existingDocuments.get(document.path);
    const shouldReindex = force || !existing || existing.checksum !== document.checksum;

    let documentId = existing?.id;
    if (!documentId) {
      const result = database.prepare(`
        INSERT INTO documents(path, kind, shard_key, checksum, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(document.path, document.kind, document.shardKey, document.checksum, createTimestamp());
      documentId = Number(result.lastInsertRowid);
    } else {
      database.prepare(`
        UPDATE documents
        SET kind = ?, shard_key = ?, checksum = ?, updated_at = ?
        WHERE id = ?
      `).run(document.kind, document.shardKey, document.checksum, createTimestamp(), documentId);
    }

    if (!shouldReindex) {
      database.prepare("UPDATE chunks SET sort_order = ? WHERE document_id = ?").run(document.searchOrder, documentId);
      continue;
    }

    deleteDocumentChunks(database, documentId);
    const chunks = buildSearchChunks(document.text);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      const result = database.prepare(`
        INSERT INTO chunks(document_id, path, kind, shard_key, sort_order, chunk_index, start_line, end_line, text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        documentId,
        document.path,
        document.kind,
        document.shardKey,
        document.searchOrder,
        chunkIndex,
        chunk.startLine,
        chunk.endLine,
        chunk.text,
      );
      database.prepare("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)").run(Number(result.lastInsertRowid), chunk.text);
    }
    indexedDocuments += 1;
  }

  let removedDocuments = 0;
  for (const existing of existingDocuments.values()) {
    if (!seenPaths.has(existing.path)) {
      removeDocument(database, existing.id);
      removedDocuments += 1;
    }
  }

  setMetadata(database, "lastIndexedAt", createTimestamp());
  return {
    indexedDocuments,
    removedDocuments,
    chunkCount: countChunks(database),
  };
}

export class SqliteFtsMemoryBackend implements AgentMemoryBackend {
  readonly id = "sqlite-fts" as const;

  private readonly markdownFallback = new MarkdownMemoryBackend();

  async appendTurnMemory(args: AppendAgentTurnMemoryArgs): Promise<void> {
    await appendAgentTurnMemoryFile(args);
    await this.reindex(args.agentId).catch(() => undefined);
  }

  async appendCompactionMemory(args: AppendAgentCompactionMemoryArgs): Promise<void> {
    await appendAgentCompactionMemoryFile(args);
    await this.reindex(args.agentId).catch(() => undefined);
  }

  async search(agentId: RoomAgentId, query: string, options?: AgentMemorySearchOptions): Promise<MemorySearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const matchQuery = buildMatchQuery(normalizedQuery);
    if (!matchQuery) {
      return this.markdownFallback.search(agentId, query, options);
    }

    const maxResults = typeof options?.maxResults === "number" && Number.isFinite(options.maxResults)
      ? Math.max(1, Math.min(20, Math.round(options.maxResults)))
      : 8;
    const minScore = typeof options?.minScore === "number" && Number.isFinite(options.minScore)
      ? options.minScore
      : 0;
    const candidateLimit = Math.max(maxResults * 12, 24);
    const queryTokens = new Set(tokenize(normalizedQuery));
    const queryLower = normalizedQuery.toLowerCase();

    await this.reindex(agentId).catch(() => undefined);
    await ensureMemoryIndexDir();
    const database = openDatabase(agentId);
    try {
      const candidates = database.prepare(`
        SELECT
          c.path AS path,
          c.start_line AS startLine,
          c.end_line AS endLine,
          c.text AS text,
          c.sort_order AS sortOrder,
          c.chunk_index AS chunkIndex,
          bm25(chunks_fts) AS rank
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(matchQuery, candidateLimit) as SearchCandidateRow[];

      if (candidates.length === 0) {
        return this.markdownFallback.search(agentId, query, options);
      }

      const scored = candidates
        .map((candidate, index) => {
          const overlap = countQueryOverlap(queryTokens, candidate.text);
          const substringBoost = candidate.text.toLowerCase().includes(queryLower) ? 2 : 0;
          const headingBoost = candidate.text.startsWith("## ") ? 1 : 0;
          const ftsBoost = Math.max(0.1, (candidateLimit - index) / candidateLimit);
          const recencyBoost = Math.max(0, 1 - candidate.sortOrder / Math.max(1, candidates.length)) * 0.5;
          const score = overlap + substringBoost + headingBoost + ftsBoost + recencyBoost;
          return {
            path: candidate.path,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            snippet: formatChunkPreview(candidate.text, candidate.startLine),
            score,
            sortOrder: candidate.sortOrder,
            chunkIndex: candidate.chunkIndex,
          };
        })
        .filter((candidate) => candidate.score >= minScore)
        .sort(
          (left, right) =>
            right.score - left.score
            || left.sortOrder - right.sortOrder
            || left.path.localeCompare(right.path)
            || left.startLine - right.startLine
            || left.chunkIndex - right.chunkIndex,
        )
        .slice(0, maxResults)
        .map((candidate) => ({
          path: candidate.path,
          startLine: candidate.startLine,
          endLine: candidate.endLine,
          snippet: candidate.snippet,
          score: candidate.score,
        }));

      return scored.length > 0 ? scored : this.markdownFallback.search(agentId, query, options);
    } catch {
      return this.markdownFallback.search(agentId, query, options);
    } finally {
      database.close();
    }
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
    const sourceDocuments = await collectMemorySourceDocuments(agentId);
    const indexPath = getMemoryIndexPath(agentId);
    const indexExists = await stat(indexPath).then(() => true).catch(() => false);
    if (!indexExists) {
      return {
        ...summary,
        backend: this.id,
        documentCount: 0,
        chunkCount: 0,
        dirty: sourceDocuments.length > 0,
        missingIndex: sourceDocuments.length > 0,
      };
    }

    await ensureMemoryIndexDir();
    const database = openDatabase(agentId);
    try {
      const indexedDocuments = listIndexedDocuments(database);
      const indexedChecksums = new Map(indexedDocuments.map((document) => [document.path, document.checksum]));
      const dirty =
        indexedDocuments.length !== sourceDocuments.length
        || sourceDocuments.some((document) => indexedChecksums.get(document.path) !== document.checksum);

      return {
        ...summary,
        backend: this.id,
        documentCount: indexedDocuments.length,
        chunkCount: countChunks(database),
        lastIndexedAt: getMetadata(database, "lastIndexedAt"),
        dirty,
        missingIndex: indexedDocuments.length === 0 && sourceDocuments.length > 0,
      };
    } finally {
      database.close();
    }
  }

  async reindex(agentId: RoomAgentId, options?: { force?: boolean }): Promise<AgentMemoryIndexResult> {
    const startedAt = performance.now();
    await ensureMemoryIndexDir();
    const documents = await collectMemorySourceDocuments(agentId);
    const database = openDatabase(agentId);
    try {
      database.exec("BEGIN");
      const synced = syncIndex(database, documents, Boolean(options?.force));
      database.exec("COMMIT");
      return {
        backend: this.id,
        mode: options?.force ? "full" : "incremental",
        indexedDocuments: synced.indexedDocuments,
        removedDocuments: synced.removedDocuments,
        chunkCount: synced.chunkCount,
        durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
  }
}
