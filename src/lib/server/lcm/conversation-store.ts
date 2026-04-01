import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { estimateTokens } from "./estimate-tokens";

export type ConversationId = number;
export type MessageId = number;
export type SummaryId = string;
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessagePartType =
  | "text"
  | "reasoning"
  | "tool"
  | "patch"
  | "file"
  | "subtask"
  | "compaction"
  | "step_start"
  | "step_finish"
  | "snapshot"
  | "agent"
  | "retry";

export interface CreateConversationInput {
  sessionId: string;
  sessionKey?: string;
  title?: string;
}

export interface ConversationRecord {
  conversationId: ConversationId;
  sessionId: string;
  sessionKey: string | null;
  title: string | null;
  bootstrappedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMessageInput {
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount?: number;
  createdAt?: string;
}

export interface MessageRecord {
  messageId: MessageId;
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
  createdAt: Date;
}

export interface CreateMessagePartInput {
  sessionId: string;
  partType: MessagePartType;
  ordinal: number;
  textContent?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  toolInput?: string | null;
  toolOutput?: string | null;
  metadata?: string | null;
}

export interface MessagePartRecord {
  partId: string;
  messageId: MessageId;
  sessionId: string;
  partType: MessagePartType;
  ordinal: number;
  textContent: string | null;
  toolCallId: string | null;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  metadata: string | null;
}

export interface MessageSearchInput {
  conversationId?: ConversationId;
  query: string;
  mode: "regex" | "full_text";
  since?: Date;
  before?: Date;
  limit?: number;
}

export interface MessageSearchResult {
  messageId: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  snippet: string;
  createdAt: Date;
  rank?: number;
}

function toConversationRecord(row: Record<string, unknown>): ConversationRecord {
  return {
    conversationId: Number(row.conversation_id),
    sessionId: String(row.session_id),
    sessionKey: row.session_key ? String(row.session_key) : null,
    title: row.title ? String(row.title) : null,
    bootstrappedAt: row.bootstrapped_at ? new Date(String(row.bootstrapped_at)) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function toMessageRecord(row: Record<string, unknown>): MessageRecord {
  return {
    messageId: Number(row.message_id),
    conversationId: Number(row.conversation_id),
    seq: Number(row.seq),
    role: row.role as MessageRole,
    content: String(row.content ?? ""),
    tokenCount: Number(row.token_count ?? 0),
    createdAt: new Date(String(row.created_at)),
  };
}

function toMessagePartRecord(row: Record<string, unknown>): MessagePartRecord {
  return {
    partId: String(row.part_id),
    messageId: Number(row.message_id),
    sessionId: String(row.session_id),
    partType: row.part_type as MessagePartType,
    ordinal: Number(row.ordinal),
    textContent: typeof row.text_content === "string" ? row.text_content : null,
    toolCallId: typeof row.tool_call_id === "string" ? row.tool_call_id : null,
    toolName: typeof row.tool_name === "string" ? row.tool_name : null,
    toolInput: typeof row.tool_input === "string" ? row.tool_input : null,
    toolOutput: typeof row.tool_output === "string" ? row.tool_output : null,
    metadata: typeof row.metadata === "string" ? row.metadata : null,
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

export class ConversationStore {
  constructor(private db: DatabaseSync) {}

  async withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    const result = this.db.prepare(
      `INSERT INTO conversations (session_id, session_key, title) VALUES (?, ?, ?)`,
    ).run(input.sessionId, input.sessionKey ?? null, input.title ?? null);
    const row = this.db.prepare(
      `SELECT conversation_id, session_id, session_key, title, bootstrapped_at, created_at, updated_at FROM conversations WHERE conversation_id = ?`,
    ).get(Number(result.lastInsertRowid)) as Record<string, unknown>;
    return toConversationRecord(row);
  }

  async getConversation(conversationId: ConversationId): Promise<ConversationRecord | null> {
    const row = this.db.prepare(
      `SELECT conversation_id, session_id, session_key, title, bootstrapped_at, created_at, updated_at FROM conversations WHERE conversation_id = ?`,
    ).get(conversationId) as Record<string, unknown> | undefined;
    return row ? toConversationRecord(row) : null;
  }

  async getConversationBySessionKey(sessionKey: string): Promise<ConversationRecord | null> {
    const row = this.db.prepare(
      `SELECT conversation_id, session_id, session_key, title, bootstrapped_at, created_at, updated_at FROM conversations WHERE session_key = ? LIMIT 1`,
    ).get(sessionKey) as Record<string, unknown> | undefined;
    return row ? toConversationRecord(row) : null;
  }

  async getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null> {
    const row = this.db.prepare(
      `SELECT conversation_id, session_id, session_key, title, bootstrapped_at, created_at, updated_at FROM conversations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? toConversationRecord(row) : null;
  }

  async deleteConversationBySessionKey(sessionKey: string): Promise<void> {
    this.db.prepare(`DELETE FROM conversations WHERE session_key = ?`).run(sessionKey);
  }

  async getOrCreateConversation(sessionId: string, opts?: { title?: string; sessionKey?: string }): Promise<ConversationRecord> {
    const byKey = opts?.sessionKey ? await this.getConversationBySessionKey(opts.sessionKey) : null;
    if (byKey) {
      if (byKey.sessionId !== sessionId) {
        this.db.prepare(`UPDATE conversations SET session_id = ?, updated_at = datetime('now') WHERE conversation_id = ?`).run(sessionId, byKey.conversationId);
      }
      return { ...byKey, sessionId };
    }
    const bySessionId = await this.getConversationBySessionId(sessionId);
    if (bySessionId) {
      return bySessionId;
    }
    return this.createConversation({ sessionId, sessionKey: opts?.sessionKey, title: opts?.title });
  }

  async markConversationBootstrapped(conversationId: ConversationId): Promise<void> {
    this.db.prepare(
      `UPDATE conversations SET bootstrapped_at = COALESCE(bootstrapped_at, datetime('now')), updated_at = datetime('now') WHERE conversation_id = ?`,
    ).run(conversationId);
  }

  async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.conversationId, input.seq, input.role, input.content, input.tokenCount ?? estimateTokens(input.content), createdAt);
    const messageId = Number(result.lastInsertRowid);
    try {
      this.db.prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`).run(messageId, input.content);
    } catch {}
    const row = this.db.prepare(
      `SELECT message_id, conversation_id, seq, role, content, token_count, created_at FROM messages WHERE message_id = ?`,
    ).get(messageId) as Record<string, unknown>;
    return toMessageRecord(row);
  }

  async getMaxSeq(conversationId: ConversationId): Promise<number> {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE conversation_id = ?`).get(conversationId) as { max_seq?: number };
    return row?.max_seq ?? 0;
  }

  async getMessageById(messageId: MessageId): Promise<MessageRecord | null> {
    const row = this.db.prepare(
      `SELECT message_id, conversation_id, seq, role, content, token_count, created_at FROM messages WHERE message_id = ?`,
    ).get(messageId) as Record<string, unknown> | undefined;
    return row ? toMessageRecord(row) : null;
  }

  async getMessages(conversationId: ConversationId, opts?: { afterSeq?: number; limit?: number }): Promise<MessageRecord[]> {
    const afterSeq = opts?.afterSeq ?? -1;
    const limit = opts?.limit;
    const rows = (limit != null
      ? this.db.prepare(`SELECT message_id, conversation_id, seq, role, content, token_count, created_at FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?`).all(conversationId, afterSeq, limit)
      : this.db.prepare(`SELECT message_id, conversation_id, seq, role, content, token_count, created_at FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq`).all(conversationId, afterSeq)) as Record<string, unknown>[];
    return rows.map(toMessageRecord);
  }

  async createMessageParts(messageId: MessageId, parts: CreateMessagePartInput[]): Promise<void> {
    if (parts.length === 0) {
      return;
    }
    const stmt = this.db.prepare(
      `INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, text_content, tool_call_id, tool_name, tool_input, tool_output, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const part of parts) {
      stmt.run(randomUUID(), messageId, part.sessionId, part.partType, part.ordinal, part.textContent ?? null, part.toolCallId ?? null, part.toolName ?? null, part.toolInput ?? null, part.toolOutput ?? null, part.metadata ?? null);
    }
  }

  async getMessageParts(messageId: MessageId): Promise<MessagePartRecord[]> {
    const rows = this.db.prepare(
      `SELECT part_id, message_id, session_id, part_type, ordinal, text_content, tool_call_id, tool_name, tool_input, tool_output, metadata FROM message_parts WHERE message_id = ? ORDER BY ordinal`,
    ).all(messageId) as Record<string, unknown>[];
    return rows.map(toMessagePartRecord);
  }

  async searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]> {
    const limit = input.limit ?? 50;
    const rows = this.db.prepare(
      `SELECT message_id, conversation_id, role, content, created_at FROM messages ${input.conversationId != null ? "WHERE conversation_id = ?" : ""} ORDER BY created_at DESC`,
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
      .map((row): MessageSearchResult | null => {
        const content = String(row.content ?? "");
        const matched = re ? re.test(content) : content.toLowerCase().includes(input.query.toLowerCase());
        if (!matched) {
          return null;
        }
        return {
          messageId: Number(row.message_id),
          conversationId: Number(row.conversation_id),
          role: row.role as MessageRole,
          snippet: createSnippet(content, input.query),
          createdAt: new Date(String(row.created_at)),
          rank: 0,
        };
      })
      .filter((row): row is MessageSearchResult => row !== null)
      .slice(0, limit);
  }
}
