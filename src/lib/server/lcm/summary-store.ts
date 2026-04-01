import type { DatabaseSync } from "node:sqlite";
import { estimateTokens } from "./estimate-tokens";
import type { ConversationId, MessageId, SummaryId } from "./conversation-store";

export type SummaryKind = "leaf" | "condensed";
export type ContextItemType = "message" | "summary";

export interface CreateSummaryInput {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  depth?: number;
  content: string;
  tokenCount?: number;
  fileIds?: string[];
  earliestAt?: Date;
  latestAt?: Date;
  descendantCount?: number;
  descendantTokenCount?: number;
  sourceMessageTokenCount?: number;
  model?: string;
}

export interface SummaryRecord {
  summaryId: SummaryId;
  conversationId: ConversationId;
  kind: SummaryKind;
  depth: number;
  content: string;
  tokenCount: number;
  fileIds: string[];
  earliestAt: Date | null;
  latestAt: Date | null;
  descendantCount: number;
  descendantTokenCount: number;
  sourceMessageTokenCount: number;
  model: string;
  createdAt: Date;
}

export interface ContextItemRecord {
  conversationId: ConversationId;
  ordinal: number;
  itemType: ContextItemType;
  messageId: MessageId | null;
  summaryId: SummaryId | null;
  createdAt: Date;
}

export interface SummarySearchInput {
  conversationId?: number;
  query: string;
  mode: "regex" | "full_text";
  since?: Date;
  before?: Date;
  limit?: number;
}

export interface SummarySearchResult {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  snippet: string;
  createdAt: Date;
  rank?: number;
}

function toSummaryRecord(row: Record<string, unknown>): SummaryRecord {
  let fileIds: string[] = [];
  try {
    fileIds = JSON.parse(String(row.file_ids ?? "[]")) as string[];
  } catch {}
  return {
    summaryId: String(row.summary_id),
    conversationId: Number(row.conversation_id),
    kind: row.kind as SummaryKind,
    depth: Number(row.depth ?? 0),
    content: String(row.content ?? ""),
    tokenCount: Number(row.token_count ?? 0),
    fileIds,
    earliestAt: row.earliest_at ? new Date(String(row.earliest_at)) : null,
    latestAt: row.latest_at ? new Date(String(row.latest_at)) : null,
    descendantCount: Number(row.descendant_count ?? 0),
    descendantTokenCount: Number(row.descendant_token_count ?? 0),
    sourceMessageTokenCount: Number(row.source_message_token_count ?? 0),
    model: typeof row.model === "string" ? row.model : "unknown",
    createdAt: new Date(String(row.created_at)),
  };
}

function toContextItemRecord(row: Record<string, unknown>): ContextItemRecord {
  return {
    conversationId: Number(row.conversation_id),
    ordinal: Number(row.ordinal),
    itemType: row.item_type as ContextItemType,
    messageId: row.message_id != null ? Number(row.message_id) : null,
    summaryId: row.summary_id ? String(row.summary_id) : null,
    createdAt: new Date(String(row.created_at)),
  };
}

function createSnippet(content: string, query: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const index = normalized.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) {
    return normalized.slice(0, 220);
  }
  const start = Math.max(0, index - 80);
  const end = Math.min(normalized.length, index + query.length + 140);
  return normalized.slice(start, end).trim();
}

export class SummaryStore {
  constructor(private db: DatabaseSync) {}

  async insertSummary(input: CreateSummaryInput): Promise<SummaryRecord> {
    this.db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, file_ids, earliest_at, latest_at, descendant_count, descendant_token_count, source_message_token_count, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.summaryId,
      input.conversationId,
      input.kind,
      input.depth ?? (input.kind === "leaf" ? 0 : 1),
      input.content,
      input.tokenCount ?? estimateTokens(input.content),
      JSON.stringify(input.fileIds ?? []),
      input.earliestAt?.toISOString() ?? null,
      input.latestAt?.toISOString() ?? null,
      input.descendantCount ?? 0,
      input.descendantTokenCount ?? 0,
      input.sourceMessageTokenCount ?? 0,
      input.model ?? "unknown",
    );
    try {
      this.db.prepare(`INSERT INTO summaries_fts(summary_id, content) VALUES (?, ?)`).run(input.summaryId, input.content);
    } catch {}
    return (await this.getSummary(input.summaryId)) as SummaryRecord;
  }

  async getSummary(summaryId: string): Promise<SummaryRecord | null> {
    const row = this.db.prepare(
      `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids, earliest_at, latest_at, descendant_count, descendant_token_count, source_message_token_count, model, created_at FROM summaries WHERE summary_id = ?`,
    ).get(summaryId) as Record<string, unknown> | undefined;
    return row ? toSummaryRecord(row) : null;
  }

  async linkSummaryToMessages(summaryId: string, messageIds: number[]): Promise<void> {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO summary_messages (summary_id, message_id, ordinal) VALUES (?, ?, ?)`);
    for (const [index, messageId] of messageIds.entries()) {
      stmt.run(summaryId, messageId, index);
    }
  }

  async linkSummaryToParents(summaryId: string, parentSummaryIds: string[]): Promise<void> {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES (?, ?, ?)`);
    for (const [index, parentSummaryId] of parentSummaryIds.entries()) {
      stmt.run(summaryId, parentSummaryId, index);
    }
  }

  async getSummaryMessages(summaryId: string): Promise<number[]> {
    const rows = this.db.prepare(`SELECT message_id FROM summary_messages WHERE summary_id = ? ORDER BY ordinal`).all(summaryId) as Array<{ message_id: number }>;
    return rows.map((row) => row.message_id);
  }

  async getSummaryParents(summaryId: string): Promise<SummaryRecord[]> {
    const rows = this.db.prepare(
      `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count, s.file_ids, s.earliest_at, s.latest_at, s.descendant_count, s.descendant_token_count, s.source_message_token_count, s.model, s.created_at
       FROM summaries s JOIN summary_parents sp ON sp.parent_summary_id = s.summary_id WHERE sp.summary_id = ? ORDER BY sp.ordinal`,
    ).all(summaryId) as Record<string, unknown>[];
    return rows.map(toSummaryRecord);
  }

  async getSummaryChildren(summaryId: string): Promise<SummaryRecord[]> {
    const rows = this.db.prepare(
      `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count, s.file_ids, s.earliest_at, s.latest_at, s.descendant_count, s.descendant_token_count, s.source_message_token_count, s.model, s.created_at
       FROM summaries s JOIN summary_parents sp ON sp.summary_id = s.summary_id WHERE sp.parent_summary_id = ? ORDER BY sp.ordinal`,
    ).all(summaryId) as Record<string, unknown>[];
    return rows.map(toSummaryRecord);
  }

  async getContextItems(conversationId: number): Promise<ContextItemRecord[]> {
    const rows = this.db.prepare(`SELECT conversation_id, ordinal, item_type, message_id, summary_id, created_at FROM context_items WHERE conversation_id = ? ORDER BY ordinal`).all(conversationId) as Record<string, unknown>[];
    return rows.map(toContextItemRecord);
  }

  async getDistinctDepthsInContext(conversationId: number, options?: { maxOrdinalExclusive?: number }): Promise<number[]> {
    const rows = (typeof options?.maxOrdinalExclusive === "number" && Number.isFinite(options.maxOrdinalExclusive)
      ? this.db.prepare(`SELECT DISTINCT s.depth FROM context_items ci JOIN summaries s ON s.summary_id = ci.summary_id WHERE ci.conversation_id = ? AND ci.item_type = 'summary' AND ci.ordinal < ? ORDER BY s.depth ASC`).all(conversationId, Math.floor(options.maxOrdinalExclusive))
      : this.db.prepare(`SELECT DISTINCT s.depth FROM context_items ci JOIN summaries s ON s.summary_id = ci.summary_id WHERE ci.conversation_id = ? AND ci.item_type = 'summary' ORDER BY s.depth ASC`).all(conversationId)) as Array<{ depth: number }>;
    return rows.map((row) => row.depth);
  }

  async appendContextMessage(conversationId: number, messageId: number, createdAt?: string): Promise<void> {
    const row = this.db.prepare(`SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal FROM context_items WHERE conversation_id = ?`).get(conversationId) as { max_ordinal?: number };
    this.db.prepare(`INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, created_at) VALUES (?, ?, 'message', ?, ?)`)
      .run(conversationId, (row.max_ordinal ?? -1) + 1, messageId, createdAt ?? new Date().toISOString());
  }

  async replaceContextRangeWithSummary(input: { conversationId: number; startOrdinal: number; endOrdinal: number; summaryId: string }): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM context_items WHERE conversation_id = ? AND ordinal >= ? AND ordinal <= ?`).run(input.conversationId, input.startOrdinal, input.endOrdinal);
      this.db.prepare(`INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, 'summary', ?)`)
        .run(input.conversationId, input.startOrdinal, input.summaryId);
      const rows = this.db.prepare(`SELECT ordinal FROM context_items WHERE conversation_id = ? ORDER BY ordinal`).all(input.conversationId) as Array<{ ordinal: number }>;
      const update = this.db.prepare(`UPDATE context_items SET ordinal = ? WHERE conversation_id = ? AND ordinal = ?`);
      for (let i = 0; i < rows.length; i += 1) {
        update.run(-(i + 1), input.conversationId, rows[i]!.ordinal);
      }
      for (let i = 0; i < rows.length; i += 1) {
        update.run(i, input.conversationId, -(i + 1));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getContextTokenCount(conversationId: number): Promise<number> {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(token_count), 0) AS total FROM (
         SELECT m.token_count AS token_count FROM context_items ci JOIN messages m ON m.message_id = ci.message_id WHERE ci.conversation_id = ? AND ci.item_type = 'message'
         UNION ALL
         SELECT s.token_count AS token_count FROM context_items ci JOIN summaries s ON s.summary_id = ci.summary_id WHERE ci.conversation_id = ? AND ci.item_type = 'summary'
       ) sub`,
    ).get(conversationId, conversationId) as { total?: number };
    return row?.total ?? 0;
  }

  async searchSummaries(input: SummarySearchInput): Promise<SummarySearchResult[]> {
    const rows = this.db.prepare(
      `SELECT summary_id, conversation_id, kind, content, created_at FROM summaries ${input.conversationId != null ? "WHERE conversation_id = ?" : ""} ORDER BY created_at DESC`,
    ).all(...(input.conversationId != null ? [input.conversationId] : [])) as Array<Record<string, unknown>>;
    let re: RegExp | null = null;
    if (input.mode === "regex") {
      try {
        re = new RegExp(input.query, "i");
      } catch {
        return [];
      }
    }
    return rows
      .map((row): SummarySearchResult | null => {
        const content = String(row.content ?? "");
        const matched = re ? re.test(content) : content.toLowerCase().includes(input.query.toLowerCase());
        if (!matched) {
          return null;
        }
        return {
          summaryId: String(row.summary_id),
          conversationId: Number(row.conversation_id),
          kind: row.kind as SummaryKind,
          snippet: createSnippet(content, input.query),
          createdAt: new Date(String(row.created_at)),
          rank: 0,
        };
      })
      .filter((row): row is SummarySearchResult => row !== null)
      .slice(0, input.limit ?? 50);
  }
}
