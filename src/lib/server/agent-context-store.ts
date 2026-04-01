import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AssistantMessageMeta,
  MessageImageAttachment,
  ProviderCompatibility,
  RoomAgentId,
  RoomMessageEmission,
  RoomSender,
  RoomToolActionUnion,
  ToolExecution,
} from "@/lib/chat/types";

export type AgentContextMessageRole = "user" | "assistant" | "system";

export type AgentContextMessageSource =
  | "room_incoming"
  | "continuation_snapshot"
  | "room_run_completion";

export type AgentContextPartType =
  | "incoming_room_envelope"
  | "attached_rooms"
  | "attachment_summary"
  | "continuation_snapshot"
  | "assistant_partial_draft"
  | "assistant_history_entry"
  | "tool_result"
  | "room_delivery"
  | "room_action";

export interface AgentContextMessagePartInput {
  partType: AgentContextPartType;
  textContent?: string;
  toolExecution?: ToolExecution;
  roomMessage?: RoomMessageEmission;
  roomAction?: RoomToolActionUnion;
  metadata?: unknown;
}

export interface AgentContextMessageInput {
  agentId: RoomAgentId;
  messageId: string;
  role: AgentContextMessageRole;
  source: AgentContextMessageSource;
  content: string;
  createdAt: string;
  requestId?: string;
  roomId?: string;
  roomTitle?: string;
  userMessageId?: string;
  sender?: RoomSender;
  attachments?: MessageImageAttachment[];
  meta?: AssistantMessageMeta;
  compatibility?: ProviderCompatibility | null;
  resolvedModel?: string;
  metadata?: unknown;
  parts?: AgentContextMessagePartInput[];
}

export interface AgentContextMessagePartRecord {
  partId: string;
  ordinal: number;
  partType: AgentContextPartType;
  textContent: string | null;
  toolExecution: ToolExecution | null;
  roomMessage: RoomMessageEmission | null;
  roomAction: RoomToolActionUnion | null;
  metadata: unknown;
}

export interface AgentContextMessageRecord {
  messageId: string;
  role: AgentContextMessageRole;
  source: AgentContextMessageSource;
  requestId: string | null;
  roomId: string | null;
  roomTitle: string | null;
  userMessageId: string | null;
  senderId: string | null;
  senderName: string | null;
  senderRole: string | null;
  content: string;
  attachments: MessageImageAttachment[];
  meta: AssistantMessageMeta | null;
  compatibility: ProviderCompatibility | null;
  resolvedModel: string | null;
  metadata: unknown;
  createdAt: string;
  parts: AgentContextMessagePartRecord[];
}

export interface AgentContextConversationSnapshot {
  agentId: RoomAgentId;
  conversationId: number;
  messages: AgentContextMessageRecord[];
}

export type AgentContextSummaryKind = "leaf" | "condensed";

export interface AgentContextSummaryRecord {
  summaryId: string;
  kind: AgentContextSummaryKind;
  depth: number;
  content: string;
  tokenCount: number;
  metadata: unknown;
  createdAt: string;
}

export interface AgentContextItemRecord {
  ordinal: number;
  itemType: "message" | "summary";
  createdAt: string;
  message: AgentContextMessageRecord | null;
  summary: AgentContextSummaryRecord | null;
}

export interface AgentContextStateSnapshot {
  agentId: RoomAgentId;
  conversationId: number;
  items: AgentContextItemRecord[];
}

export interface AgentContextSummaryDescription {
  summary: AgentContextSummaryRecord;
  messageIds: string[];
  parentSummaryIds: string[];
}

export interface InsertAgentContextSummaryInput {
  agentId: RoomAgentId;
  summaryId: string;
  kind: AgentContextSummaryKind;
  depth: number;
  content: string;
  tokenCount: number;
  messageIds?: string[];
  parentSummaryIds?: string[];
  metadata?: unknown;
  createdAt: string;
}

let databasePromise: Promise<DatabaseSync> | null = null;

function getContextRoot(): string {
  return path.join(process.cwd(), ".oceanking", "agent-context");
}

function getContextDbPath(): string {
  return path.join(getContextRoot(), "context.sqlite");
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value);
}

function estimateTokenCount(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }

  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function ensureSchema(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_conversations (
      conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_messages (
      message_id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES agent_conversations(conversation_id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      source TEXT NOT NULL CHECK (source IN ('room_incoming', 'continuation_snapshot', 'room_run_completion')),
      request_id TEXT,
      room_id TEXT,
      room_title TEXT,
      user_message_id TEXT,
      sender_id TEXT,
      sender_name TEXT,
      sender_role TEXT,
      content TEXT NOT NULL,
      attachments_json TEXT,
      meta_json TEXT,
      compatibility_json TEXT,
      resolved_model TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_message_parts (
      part_id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL REFERENCES agent_messages(message_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      part_type TEXT NOT NULL CHECK (
        part_type IN (
          'incoming_room_envelope',
          'attached_rooms',
          'attachment_summary',
          'continuation_snapshot',
          'assistant_partial_draft',
          'assistant_history_entry',
          'tool_result',
          'room_delivery',
          'room_action'
        )
      ),
      text_content TEXT,
      tool_execution_json TEXT,
      room_message_json TEXT,
      room_action_json TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (message_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS agent_summaries (
      summary_id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES agent_conversations(conversation_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_summary_messages (
      summary_id TEXT NOT NULL REFERENCES agent_summaries(summary_id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES agent_messages(message_id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (summary_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS agent_summary_parents (
      summary_id TEXT NOT NULL REFERENCES agent_summaries(summary_id) ON DELETE CASCADE,
      parent_summary_id TEXT NOT NULL REFERENCES agent_summaries(summary_id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (summary_id, parent_summary_id)
    );

    CREATE TABLE IF NOT EXISTS agent_context_items (
      conversation_id INTEGER NOT NULL REFERENCES agent_conversations(conversation_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('message', 'summary')),
      message_id TEXT REFERENCES agent_messages(message_id) ON DELETE RESTRICT,
      summary_id TEXT REFERENCES agent_summaries(summary_id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, ordinal),
      CHECK (
        (item_type = 'message' AND message_id IS NOT NULL AND summary_id IS NULL)
        OR
        (item_type = 'summary' AND summary_id IS NOT NULL AND message_id IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS agent_messages_conversation_idx ON agent_messages (conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS agent_message_parts_message_idx ON agent_message_parts (message_id, ordinal);
    CREATE INDEX IF NOT EXISTS agent_context_items_conversation_idx ON agent_context_items (conversation_id, ordinal);
  `);
}

async function getDatabase(): Promise<DatabaseSync> {
  if (!databasePromise) {
    databasePromise = (async () => {
      await mkdir(getContextRoot(), { recursive: true });
      const db = new DatabaseSync(getContextDbPath());
      ensureSchema(db);
      return db;
    })();
  }

  return databasePromise;
}

function getConversationRow(db: DatabaseSync, agentId: RoomAgentId): { conversation_id: number } | undefined {
  return db.prepare(
    `SELECT conversation_id
     FROM agent_conversations
     WHERE agent_id = ?`,
  ).get(agentId) as { conversation_id: number } | undefined;
}

function getOrCreateConversationId(db: DatabaseSync, agentId: RoomAgentId, timestamp: string): number {
  db.prepare(
    `INSERT INTO agent_conversations (agent_id, created_at, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (agent_id) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(agentId, timestamp, timestamp);

  const row = db.prepare(
    `SELECT conversation_id FROM agent_conversations WHERE agent_id = ?`,
  ).get(agentId) as { conversation_id: number } | undefined;

  if (!row) {
    throw new Error(`Failed to create agent conversation for ${agentId}`);
  }

  return row.conversation_id;
}

function appendContextItem(db: DatabaseSync, conversationId: number, messageId: string, timestamp: string): void {
  const row = db.prepare(
    `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
     FROM agent_context_items
     WHERE conversation_id = ?`,
  ).get(conversationId) as { max_ordinal: number };

  db.prepare(
    `INSERT INTO agent_context_items (conversation_id, ordinal, item_type, message_id, created_at)
     VALUES (?, ?, 'message', ?, ?)`,
  ).run(conversationId, row.max_ordinal + 1, messageId, timestamp);
}

function appendSummaryContextItem(db: DatabaseSync, conversationId: number, summaryId: string, timestamp: string): void {
  const row = db.prepare(
    `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
     FROM agent_context_items
     WHERE conversation_id = ?`,
  ).get(conversationId) as { max_ordinal: number };

  db.prepare(
    `INSERT INTO agent_context_items (conversation_id, ordinal, item_type, summary_id, created_at)
     VALUES (?, ?, 'summary', ?, ?)`,
  ).run(conversationId, row.max_ordinal + 1, summaryId, timestamp);
}

export async function appendAgentContextMessage(input: AgentContextMessageInput): Promise<void> {
  const db = await getDatabase();
  db.exec("BEGIN IMMEDIATE");

  try {
    const conversationId = getOrCreateConversationId(db, input.agentId, input.createdAt);
    db.prepare(
      `INSERT INTO agent_messages (
        message_id,
        conversation_id,
        role,
        source,
        request_id,
        room_id,
        room_title,
        user_message_id,
        sender_id,
        sender_name,
        sender_role,
        content,
        attachments_json,
        meta_json,
        compatibility_json,
        resolved_model,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.messageId,
      conversationId,
      input.role,
      input.source,
      input.requestId ?? null,
      input.roomId ?? null,
      input.roomTitle ?? null,
      input.userMessageId ?? null,
      input.sender?.id ?? null,
      input.sender?.name ?? null,
      input.sender?.role ?? null,
      input.content,
      toJson(input.attachments ?? []),
      toJson(input.meta ?? null),
      toJson(input.compatibility ?? null),
      input.resolvedModel ?? null,
      toJson(input.metadata ?? null),
      input.createdAt,
    );

    db.prepare(`DELETE FROM agent_message_parts WHERE message_id = ?`).run(input.messageId);
    input.parts?.forEach((part, ordinal) => {
      db.prepare(
        `INSERT INTO agent_message_parts (
          message_id,
          ordinal,
          part_type,
          text_content,
          tool_execution_json,
          room_message_json,
          room_action_json,
          metadata_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.messageId,
        ordinal,
        part.partType,
        part.textContent ?? null,
        toJson(part.toolExecution ?? null),
        toJson(part.roomMessage ?? null),
        toJson(part.roomAction ?? null),
        toJson(part.metadata ?? null),
        input.createdAt,
      );
    });

    const existingContextItem = db.prepare(
      `SELECT 1 AS found
       FROM agent_context_items
       WHERE conversation_id = ? AND item_type = 'message' AND message_id = ?
       LIMIT 1`,
    ).get(conversationId, input.messageId) as { found: number } | undefined;
    if (!existingContextItem) {
      appendContextItem(db, conversationId, input.messageId, input.createdAt);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function getAgentContextConversationSnapshot(
  agentId: RoomAgentId,
): Promise<AgentContextConversationSnapshot | null> {
  const db = await getDatabase();
  const conversationRow = getConversationRow(db, agentId);
  if (!conversationRow) {
    return null;
  }

  const messageRows = db.prepare(
    `SELECT
       m.message_id,
       m.role,
       m.source,
       m.request_id,
       m.room_id,
       m.room_title,
       m.user_message_id,
       m.sender_id,
       m.sender_name,
       m.sender_role,
       m.content,
       m.attachments_json,
       m.meta_json,
       m.compatibility_json,
       m.resolved_model,
       m.metadata_json,
       m.created_at
     FROM agent_context_items ci
     JOIN agent_messages m ON m.message_id = ci.message_id
     WHERE ci.conversation_id = ?
     ORDER BY ci.ordinal ASC`,
  ).all(conversationRow.conversation_id) as Array<{
    message_id: string;
    role: AgentContextMessageRole;
    source: AgentContextMessageSource;
    request_id: string | null;
    room_id: string | null;
    room_title: string | null;
    user_message_id: string | null;
    sender_id: string | null;
    sender_name: string | null;
    sender_role: string | null;
    content: string;
    attachments_json: string | null;
    meta_json: string | null;
    compatibility_json: string | null;
    resolved_model: string | null;
    metadata_json: string | null;
    created_at: string;
  }>;

  const partsByMessageId = new Map<string, AgentContextMessagePartRecord[]>();
  const partRows = db.prepare(
    `SELECT
       part_id,
       message_id,
       ordinal,
       part_type,
       text_content,
       tool_execution_json,
       room_message_json,
       room_action_json,
       metadata_json
     FROM agent_message_parts
     WHERE message_id IN (
       SELECT m.message_id
       FROM agent_context_items ci
       JOIN agent_messages m ON m.message_id = ci.message_id
       WHERE ci.conversation_id = ?
     )
     ORDER BY message_id ASC, ordinal ASC`,
  ).all(conversationRow.conversation_id) as Array<{
    part_id: number;
    message_id: string;
    ordinal: number;
    part_type: AgentContextPartType;
    text_content: string | null;
    tool_execution_json: string | null;
    room_message_json: string | null;
    room_action_json: string | null;
    metadata_json: string | null;
  }>;

  for (const row of partRows) {
    const existing = partsByMessageId.get(row.message_id) ?? [];
    existing.push({
      partId: String(row.part_id),
      ordinal: row.ordinal,
      partType: row.part_type,
      textContent: row.text_content,
      toolExecution: safeJsonParse<ToolExecution>(row.tool_execution_json),
      roomMessage: safeJsonParse<RoomMessageEmission>(row.room_message_json),
      roomAction: safeJsonParse<RoomToolActionUnion>(row.room_action_json),
      metadata: safeJsonParse<unknown>(row.metadata_json),
    });
    partsByMessageId.set(row.message_id, existing);
  }

  return {
    agentId,
    conversationId: conversationRow.conversation_id,
    messages: messageRows.map((row) => ({
      messageId: row.message_id,
      role: row.role,
      source: row.source,
      requestId: row.request_id,
      roomId: row.room_id,
      roomTitle: row.room_title,
      userMessageId: row.user_message_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      senderRole: row.sender_role,
      content: row.content,
      attachments: safeJsonParse<MessageImageAttachment[]>(row.attachments_json) ?? [],
      meta: safeJsonParse<AssistantMessageMeta>(row.meta_json),
      compatibility: safeJsonParse<ProviderCompatibility>(row.compatibility_json),
      resolvedModel: row.resolved_model,
      metadata: safeJsonParse<unknown>(row.metadata_json),
      createdAt: row.created_at,
      parts: partsByMessageId.get(row.message_id) ?? [],
    })),
  };
}

export async function getAgentContextStateSnapshot(
  agentId: RoomAgentId,
): Promise<AgentContextStateSnapshot | null> {
  const db = await getDatabase();
  const conversationRow = getConversationRow(db, agentId);
  if (!conversationRow) {
    return null;
  }

  const messageSnapshot = await getAgentContextConversationSnapshot(agentId);
  const messagesById = new Map(messageSnapshot?.messages.map((message) => [message.messageId, message]) ?? []);

  const summaries = db.prepare(
    `SELECT
       summary_id,
       kind,
       depth,
       content,
       token_count,
       metadata_json,
       created_at
     FROM agent_summaries
     WHERE conversation_id = ?`,
  ).all(conversationRow.conversation_id) as Array<{
    summary_id: string;
    kind: AgentContextSummaryKind;
    depth: number;
    content: string;
    token_count: number;
    metadata_json: string | null;
    created_at: string;
  }>;
  const summariesById = new Map<string, AgentContextSummaryRecord>(
    summaries.map((summary) => [
      summary.summary_id,
      {
        summaryId: summary.summary_id,
        kind: summary.kind,
        depth: summary.depth,
        content: summary.content,
        tokenCount: summary.token_count,
        metadata: safeJsonParse(summary.metadata_json),
        createdAt: summary.created_at,
      },
    ]),
  );

  const itemRows = db.prepare(
    `SELECT
       ordinal,
       item_type,
       message_id,
       summary_id,
       created_at
     FROM agent_context_items
     WHERE conversation_id = ?
     ORDER BY ordinal ASC`,
  ).all(conversationRow.conversation_id) as Array<{
    ordinal: number;
    item_type: "message" | "summary";
    message_id: string | null;
    summary_id: string | null;
    created_at: string;
  }>;

  return {
    agentId,
    conversationId: conversationRow.conversation_id,
    items: itemRows.map((item) => ({
      ordinal: item.ordinal,
      itemType: item.item_type,
      createdAt: item.created_at,
      message: item.message_id ? messagesById.get(item.message_id) ?? null : null,
      summary: item.summary_id ? summariesById.get(item.summary_id) ?? null : null,
    })),
  };
}

export async function insertAgentContextSummary(input: InsertAgentContextSummaryInput): Promise<void> {
  const db = await getDatabase();
  db.exec("BEGIN IMMEDIATE");

  try {
    const conversationId = getOrCreateConversationId(db, input.agentId, input.createdAt);
    db.prepare(
      `INSERT INTO agent_summaries (
         summary_id,
         conversation_id,
         kind,
         depth,
         content,
         token_count,
         metadata_json,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.summaryId,
      conversationId,
      input.kind,
      Math.max(0, Math.floor(input.depth)),
      input.content,
      Math.max(0, Math.floor(input.tokenCount || estimateTokenCount(input.content))),
      toJson(input.metadata ?? null),
      input.createdAt,
    );

    for (const [index, messageId] of (input.messageIds ?? []).entries()) {
      db.prepare(
        `INSERT INTO agent_summary_messages (summary_id, message_id, ordinal)
         VALUES (?, ?, ?)`,
      ).run(input.summaryId, messageId, index);
    }

    for (const [index, parentSummaryId] of (input.parentSummaryIds ?? []).entries()) {
      db.prepare(
        `INSERT INTO agent_summary_parents (summary_id, parent_summary_id, ordinal)
         VALUES (?, ?, ?)`,
      ).run(input.summaryId, parentSummaryId, index);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function replaceAgentContextRangeWithSummary(args: {
  agentId: RoomAgentId;
  startOrdinal: number;
  endOrdinal: number;
  summaryId: string;
  createdAt: string;
}): Promise<void> {
  const db = await getDatabase();
  const conversationRow = getConversationRow(db, args.agentId);
  if (!conversationRow) {
    throw new Error(`Missing context conversation for ${args.agentId}`);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `DELETE FROM agent_context_items
       WHERE conversation_id = ?
         AND ordinal >= ?
         AND ordinal <= ?`,
    ).run(conversationRow.conversation_id, args.startOrdinal, args.endOrdinal);

    db.prepare(
      `INSERT INTO agent_context_items (conversation_id, ordinal, item_type, summary_id, created_at)
       VALUES (?, ?, 'summary', ?, ?)`,
    ).run(conversationRow.conversation_id, args.startOrdinal, args.summaryId, args.createdAt);

    const rows = db.prepare(
      `SELECT ordinal
       FROM agent_context_items
       WHERE conversation_id = ?
       ORDER BY ordinal ASC`,
    ).all(conversationRow.conversation_id) as Array<{ ordinal: number }>;

    const updateStatement = db.prepare(
      `UPDATE agent_context_items
       SET ordinal = ?
       WHERE conversation_id = ? AND ordinal = ?`,
    );

    for (let index = 0; index < rows.length; index += 1) {
      updateStatement.run(-(index + 1), conversationRow.conversation_id, rows[index]?.ordinal);
    }
    for (let index = 0; index < rows.length; index += 1) {
      updateStatement.run(index, conversationRow.conversation_id, -(index + 1));
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function appendAgentContextSummaryItem(args: {
  agentId: RoomAgentId;
  summaryId: string;
  createdAt: string;
}): Promise<void> {
  const db = await getDatabase();
  const conversationId = getOrCreateConversationId(db, args.agentId, args.createdAt);
  appendSummaryContextItem(db, conversationId, args.summaryId, args.createdAt);
}

export async function exportAgentContextSummaryGraph(agentId: RoomAgentId): Promise<{
  summaries: AgentContextSummaryRecord[];
  edges: Array<{ summaryId: string; parentSummaryId: string; ordinal: number }>;
} | null> {
  const db = await getDatabase();
  const conversationRow = getConversationRow(db, agentId);
  if (!conversationRow) {
    return null;
  }

  const allSummaries = db.prepare(
    `SELECT summary_id, kind, depth, content, token_count, metadata_json, created_at
     FROM agent_summaries
     WHERE conversation_id = ?
     ORDER BY created_at ASC`,
  ).all(conversationRow.conversation_id) as Array<{
    summary_id: string;
    kind: AgentContextSummaryKind;
    depth: number;
    content: string;
    token_count: number;
    metadata_json: string | null;
    created_at: string;
  }>;
  const edges = db.prepare(
    `SELECT summary_id, parent_summary_id, ordinal
     FROM agent_summary_parents
     WHERE summary_id IN (
       SELECT summary_id FROM agent_summaries WHERE conversation_id = ?
     )
     ORDER BY summary_id ASC, ordinal ASC`,
  ).all(conversationRow.conversation_id) as Array<{ summary_id: string; parent_summary_id: string; ordinal: number }>;

  return {
    summaries: allSummaries.map((summary) => ({
      summaryId: summary.summary_id,
      kind: summary.kind,
      depth: summary.depth,
      content: summary.content,
      tokenCount: summary.token_count,
      metadata: safeJsonParse(summary.metadata_json),
      createdAt: summary.created_at,
    })),
    edges: edges.map((edge) => ({
      summaryId: edge.summary_id,
      parentSummaryId: edge.parent_summary_id,
      ordinal: edge.ordinal,
    })),
  };
}

export async function listAgentContextMessages(agentId: RoomAgentId): Promise<AgentContextMessageRecord[]> {
  const db = await getDatabase();
  const conversationRow = getConversationRow(db, agentId);
  if (!conversationRow) {
    return [];
  }

  const rows = db.prepare(
    `SELECT
       message_id,
       role,
       source,
       request_id,
       room_id,
       room_title,
       user_message_id,
       sender_id,
       sender_name,
       sender_role,
       content,
       attachments_json,
       meta_json,
       compatibility_json,
       resolved_model,
       metadata_json,
       created_at
     FROM agent_messages
     WHERE conversation_id = ?
     ORDER BY created_at ASC`,
  ).all(conversationRow.conversation_id) as Array<{
    message_id: string;
    role: AgentContextMessageRole;
    source: AgentContextMessageSource;
    request_id: string | null;
    room_id: string | null;
    room_title: string | null;
    user_message_id: string | null;
    sender_id: string | null;
    sender_name: string | null;
    sender_role: string | null;
    content: string;
    attachments_json: string | null;
    meta_json: string | null;
    compatibility_json: string | null;
    resolved_model: string | null;
    metadata_json: string | null;
    created_at: string;
  }>;

  const partRows = db.prepare(
    `SELECT
       part_id,
       message_id,
       ordinal,
       part_type,
       text_content,
       tool_execution_json,
       room_message_json,
       room_action_json,
       metadata_json
     FROM agent_message_parts
     WHERE message_id IN (
       SELECT message_id FROM agent_messages WHERE conversation_id = ?
     )
     ORDER BY message_id ASC, ordinal ASC`,
  ).all(conversationRow.conversation_id) as Array<{
    part_id: number;
    message_id: string;
    ordinal: number;
    part_type: AgentContextPartType;
    text_content: string | null;
    tool_execution_json: string | null;
    room_message_json: string | null;
    room_action_json: string | null;
    metadata_json: string | null;
  }>;

  const partsByMessageId = new Map<string, AgentContextMessagePartRecord[]>();
  for (const row of partRows) {
    const existing = partsByMessageId.get(row.message_id) ?? [];
    existing.push({
      partId: String(row.part_id),
      ordinal: row.ordinal,
      partType: row.part_type,
      textContent: row.text_content,
      toolExecution: safeJsonParse<ToolExecution>(row.tool_execution_json),
      roomMessage: safeJsonParse<RoomMessageEmission>(row.room_message_json),
      roomAction: safeJsonParse<RoomToolActionUnion>(row.room_action_json),
      metadata: safeJsonParse<unknown>(row.metadata_json),
    });
    partsByMessageId.set(row.message_id, existing);
  }

  return rows.map((row) => ({
    messageId: row.message_id,
    role: row.role,
    source: row.source,
    requestId: row.request_id,
    roomId: row.room_id,
    roomTitle: row.room_title,
    userMessageId: row.user_message_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderRole: row.sender_role,
    content: row.content,
    attachments: safeJsonParse<MessageImageAttachment[]>(row.attachments_json) ?? [],
    meta: safeJsonParse<AssistantMessageMeta>(row.meta_json),
    compatibility: safeJsonParse<ProviderCompatibility>(row.compatibility_json),
    resolvedModel: row.resolved_model,
    metadata: safeJsonParse<unknown>(row.metadata_json),
    createdAt: row.created_at,
    parts: partsByMessageId.get(row.message_id) ?? [],
  }));
}

export async function getAgentContextMessageRecord(
  agentId: RoomAgentId,
  messageId: string,
): Promise<AgentContextMessageRecord | null> {
  const messages = await listAgentContextMessages(agentId);
  return messages.find((message) => message.messageId === messageId) ?? null;
}

export async function listAgentContextSummaries(agentId: RoomAgentId): Promise<AgentContextSummaryRecord[]> {
  const db = await getDatabase();
  const conversationRow = getConversationRow(db, agentId);
  if (!conversationRow) {
    return [];
  }

  const rows = db.prepare(
    `SELECT summary_id, kind, depth, content, token_count, metadata_json, created_at
     FROM agent_summaries
     WHERE conversation_id = ?
     ORDER BY created_at ASC`,
  ).all(conversationRow.conversation_id) as Array<{
    summary_id: string;
    kind: AgentContextSummaryKind;
    depth: number;
    content: string;
    token_count: number;
    metadata_json: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    summaryId: row.summary_id,
    kind: row.kind,
    depth: row.depth,
    content: row.content,
    tokenCount: row.token_count,
    metadata: safeJsonParse(row.metadata_json),
    createdAt: row.created_at,
  }));
}

export async function getAgentContextSummaryDescription(
  agentId: RoomAgentId,
  summaryId: string,
): Promise<AgentContextSummaryDescription | null> {
  const db = await getDatabase();
  const conversationRow = getConversationRow(db, agentId);
  if (!conversationRow) {
    return null;
  }

  const summaryRow = db.prepare(
    `SELECT summary_id, kind, depth, content, token_count, metadata_json, created_at
     FROM agent_summaries
     WHERE conversation_id = ? AND summary_id = ?`,
  ).get(conversationRow.conversation_id, summaryId) as {
    summary_id: string;
    kind: AgentContextSummaryKind;
    depth: number;
    content: string;
    token_count: number;
    metadata_json: string | null;
    created_at: string;
  } | undefined;
  if (!summaryRow) {
    return null;
  }

  const messageRows = db.prepare(
    `SELECT message_id
     FROM agent_summary_messages
     WHERE summary_id = ?
     ORDER BY ordinal ASC`,
  ).all(summaryId) as Array<{ message_id: string }>;
  const parentRows = db.prepare(
    `SELECT parent_summary_id
     FROM agent_summary_parents
     WHERE summary_id = ?
     ORDER BY ordinal ASC`,
  ).all(summaryId) as Array<{ parent_summary_id: string }>;

  return {
    summary: {
      summaryId: summaryRow.summary_id,
      kind: summaryRow.kind,
      depth: summaryRow.depth,
      content: summaryRow.content,
      tokenCount: summaryRow.token_count,
      metadata: safeJsonParse(summaryRow.metadata_json),
      createdAt: summaryRow.created_at,
    },
    messageIds: messageRows.map((row) => row.message_id),
    parentSummaryIds: parentRows.map((row) => row.parent_summary_id),
  };
}

export async function clearAgentContextConversation(agentId: RoomAgentId): Promise<void> {
  const db = await getDatabase();
  db.prepare(`DELETE FROM agent_conversations WHERE agent_id = ?`).run(agentId);
}

export async function closeAgentContextStore(): Promise<void> {
  const db = await databasePromise;
  databasePromise = null;
  db?.close();
}
