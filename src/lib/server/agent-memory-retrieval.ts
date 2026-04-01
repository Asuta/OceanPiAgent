import {
  getAgentContextMessageRecord,
  getAgentContextSummaryDescription,
  listAgentContextMessages,
  listAgentContextSummaries,
  type AgentContextMessageRecord,
  type AgentContextSummaryDescription,
} from "./agent-context-store";
import { readAgentMemoryFile, searchAgentMemory, type MemoryFileSlice, type MemorySearchResult } from "./agent-memory-store";
import type { RoomAgentId } from "@/lib/chat/types";

export type MemoryHandleType = "message" | "summary" | "file";

export interface ContextMemorySearchResult {
  handle: string;
  id: string;
  type: "message" | "summary";
  roomId: string | null;
  roomTitle: string | null;
  source?: string;
  createdAt: string;
  snippet: string;
  score: number;
}

export interface LegacyMemorySearchResult extends MemorySearchResult {
  handle: string;
  type: "file";
  id: string;
}

export interface MemoryDescribeResult {
  handle: string;
  type: MemoryHandleType;
  message?: {
    messageId: string;
    role: string;
    source: string;
    roomId: string | null;
    roomTitle: string | null;
    createdAt: string;
    content: string;
    partTypes: string[];
  };
  summary?: {
    summaryId: string;
    kind: string;
    depth: number;
    content: string;
    createdAt: string;
    tokenCount: number;
    messageIds: string[];
    parentSummaryIds: string[];
  };
  file?: {
    path: string;
    from: number;
    lines: number;
    text: string;
  };
}

export interface MemoryExpandResult {
  handle: string;
  type: MemoryHandleType;
  summaries: Array<{
    summaryId: string;
    kind: string;
    depth: number;
    content: string;
  }>;
  messages: Array<{
    messageId: string;
    role: string;
    source: string;
    roomId: string | null;
    roomTitle: string | null;
    content: string;
    createdAt: string;
  }>;
  truncated: boolean;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function tokenize(value: string): string[] {
  return value
    .split(/\s+/g)
    .map(normalizeToken)
    .filter((token) => token.length >= 2);
}

function getPromptFacingMessageContent(message: AgentContextMessageRecord): string {
  if (message.source === "room_incoming") {
    return message.parts.find((part) => part.partType === "incoming_room_envelope")?.textContent || message.content;
  }
  if (message.source === "room_run_completion") {
    return message.parts.find((part) => part.partType === "assistant_history_entry")?.textContent || message.content;
  }
  if (message.source === "continuation_snapshot") {
    return message.parts.find((part) => part.partType === "continuation_snapshot")?.textContent || message.content;
  }

  return message.content;
}

function buildSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (!normalizedText) {
    return "";
  }

  const lowerText = normalizedText.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);
  if (index >= 0) {
    const start = Math.max(0, index - 80);
    const end = Math.min(normalizedText.length, index + lowerQuery.length + 140);
    return normalizedText.slice(start, end).trim();
  }

  return normalizedText.slice(0, 220).trim();
}

function scoreText(text: string, query: string, queryTokens: Set<string>): number {
  const snippetTokens = tokenize(text);
  const overlap = snippetTokens.reduce((count, token) => count + (queryTokens.has(token) ? 1 : 0), 0);
  const substringBoost = text.toLowerCase().includes(query.toLowerCase()) ? 3 : 0;
  return overlap + substringBoost;
}

function parseHandle(handle: string): { type: MemoryHandleType; value: string } | null {
  const trimmed = handle.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("message:")) {
    return { type: "message", value: trimmed.slice("message:".length) };
  }
  if (trimmed.startsWith("summary:")) {
    return { type: "summary", value: trimmed.slice("summary:".length) };
  }
  if (trimmed.startsWith("file:")) {
    return { type: "file", value: trimmed.slice("file:".length) };
  }

  return null;
}

function dedupeByHandle<T extends { handle: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.handle)) {
      return false;
    }
    seen.add(item.handle);
    return true;
  });
}

export async function searchAgentContextMemory(
  agentId: RoomAgentId,
  query: string,
  options?: { maxResults?: number; minScore?: number },
): Promise<ContextMemorySearchResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const queryTokens = new Set(tokenize(normalizedQuery));
  const minScore = options?.minScore ?? 1;
  const maxResults = options?.maxResults ?? 8;
  const [messages, summaries] = await Promise.all([
    listAgentContextMessages(agentId),
    listAgentContextSummaries(agentId),
  ]);

  const messageResults = messages
    .map((message): ContextMemorySearchResult | null => {
      const promptText = getPromptFacingMessageContent(message);
      const combinedText = `${message.content}\n${promptText}`;
      const score = scoreText(combinedText, normalizedQuery, queryTokens);
      if (score < minScore) {
        return null;
      }

      return {
        handle: `message:${message.messageId}`,
        id: message.messageId,
        type: "message" as const,
        roomId: message.roomId,
        roomTitle: message.roomTitle,
        source: message.source,
        createdAt: message.createdAt,
        snippet: buildSnippet(promptText || message.content, normalizedQuery),
        score,
      };
    })
    .filter((result): result is ContextMemorySearchResult => result !== null);

  const summaryResults = summaries
    .map((summary): ContextMemorySearchResult | null => {
      const score = scoreText(summary.content, normalizedQuery, queryTokens);
      if (score < minScore) {
        return null;
      }

      return {
        handle: `summary:${summary.summaryId}`,
        id: summary.summaryId,
        type: "summary" as const,
        roomId: null,
        roomTitle: null,
        createdAt: summary.createdAt,
        snippet: buildSnippet(summary.content, normalizedQuery),
        score,
      };
    })
    .filter((result): result is ContextMemorySearchResult => result !== null);

  return dedupeByHandle([...messageResults, ...summaryResults])
    .sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt))
    .slice(0, maxResults);
}

export async function searchAgentMemoryUnified(
  agentId: RoomAgentId,
  query: string,
  options?: { maxResults?: number; minScore?: number },
): Promise<Array<ContextMemorySearchResult | LegacyMemorySearchResult>> {
  const contextResults = await searchAgentContextMemory(agentId, query, options);
  const maxResults = options?.maxResults ?? 8;
  if (contextResults.length >= maxResults) {
    return contextResults.slice(0, maxResults);
  }

  const legacyResults = await searchAgentMemory(agentId, query, {
    maxResults: Math.max(1, maxResults - contextResults.length),
    minScore: options?.minScore,
  });

  return [
    ...contextResults,
    ...legacyResults.map((result) => ({
      ...result,
      handle: `file:${result.path}`,
      type: "file" as const,
      id: result.path,
    })),
  ];
}

export async function describeAgentMemoryHandle(
  agentId: RoomAgentId,
  handle: string,
): Promise<MemoryDescribeResult | null> {
  const parsed = parseHandle(handle);
  if (!parsed) {
    const legacy = await readAgentMemoryFile({
      agentId,
      relPath: handle,
      lines: 40,
    }).catch(() => null);
    if (!legacy) {
      return null;
    }
    return {
      handle: `file:${legacy.path}`,
      type: "file",
      file: legacy,
    };
  }

  if (parsed.type === "message") {
    const message = await getAgentContextMessageRecord(agentId, parsed.value);
    if (!message) {
      return null;
    }
    return {
      handle,
      type: "message",
      message: {
        messageId: message.messageId,
        role: message.role,
        source: message.source,
        roomId: message.roomId,
        roomTitle: message.roomTitle,
        createdAt: message.createdAt,
        content: getPromptFacingMessageContent(message),
        partTypes: message.parts.map((part) => part.partType),
      },
    };
  }

  if (parsed.type === "summary") {
    const summary = await getAgentContextSummaryDescription(agentId, parsed.value);
    if (!summary) {
      return null;
    }
    return {
      handle,
      type: "summary",
      summary: {
        summaryId: summary.summary.summaryId,
        kind: summary.summary.kind,
        depth: summary.summary.depth,
        content: summary.summary.content,
        createdAt: summary.summary.createdAt,
        tokenCount: summary.summary.tokenCount,
        messageIds: summary.messageIds,
        parentSummaryIds: summary.parentSummaryIds,
      },
    };
  }

  const file = await readAgentMemoryFile({
    agentId,
    relPath: parsed.value,
    lines: 40,
  }).catch(() => null);
  if (!file) {
    return null;
  }
  return {
    handle,
    type: "file",
    file,
  };
}

async function expandSummaryRecursive(args: {
  agentId: RoomAgentId;
  description: AgentContextSummaryDescription;
  depth: number;
  includeMessages: boolean;
  maxItems: number;
  seenSummaryIds: Set<string>;
  result: MemoryExpandResult;
}): Promise<void> {
  if (args.result.truncated || args.depth < 0 || args.seenSummaryIds.has(args.description.summary.summaryId)) {
    return;
  }

  args.seenSummaryIds.add(args.description.summary.summaryId);
  args.result.summaries.push({
    summaryId: args.description.summary.summaryId,
    kind: args.description.summary.kind,
    depth: args.description.summary.depth,
    content: args.description.summary.content,
  });
  if (args.result.summaries.length + args.result.messages.length >= args.maxItems) {
    args.result.truncated = true;
    return;
  }

  if (args.includeMessages) {
    for (const messageId of args.description.messageIds) {
      const message = await getAgentContextMessageRecord(args.agentId, messageId);
      if (!message) {
        continue;
      }
      args.result.messages.push({
        messageId: message.messageId,
        role: message.role,
        source: message.source,
        roomId: message.roomId,
        roomTitle: message.roomTitle,
        content: getPromptFacingMessageContent(message),
        createdAt: message.createdAt,
      });
      if (args.result.summaries.length + args.result.messages.length >= args.maxItems) {
        args.result.truncated = true;
        return;
      }
    }
  }

  if (args.depth === 0) {
    return;
  }

  for (const parentSummaryId of args.description.parentSummaryIds) {
    const parentDescription = await getAgentContextSummaryDescription(args.agentId, parentSummaryId);
    if (!parentDescription) {
      continue;
    }
    await expandSummaryRecursive({
      ...args,
      description: parentDescription,
      depth: args.depth - 1,
    });
    if (args.result.truncated) {
      return;
    }
  }
}

export async function expandAgentMemoryHandle(args: {
  agentId: RoomAgentId;
  handle: string;
  depth?: number;
  includeMessages?: boolean;
  maxItems?: number;
}): Promise<MemoryExpandResult | null> {
  const parsed = parseHandle(args.handle);
  const depth = typeof args.depth === "number" ? Math.max(0, Math.floor(args.depth)) : 1;
  const includeMessages = args.includeMessages ?? true;
  const maxItems = typeof args.maxItems === "number" ? Math.max(1, Math.floor(args.maxItems)) : 20;

  if (!parsed) {
    const file = await readAgentMemoryFile({
      agentId: args.agentId,
      relPath: args.handle,
      lines: 60,
    }).catch(() => null);
    if (!file) {
      return null;
    }
    return {
      handle: `file:${file.path}`,
      type: "file",
      summaries: [],
      messages: [
        {
          messageId: file.path,
          role: "file",
          source: "legacy_memory",
          roomId: null,
          roomTitle: null,
          content: file.text,
          createdAt: "",
        },
      ],
      truncated: false,
    };
  }

  if (parsed.type === "message") {
    const message = await getAgentContextMessageRecord(args.agentId, parsed.value);
    if (!message) {
      return null;
    }
    return {
      handle: args.handle,
      type: "message",
      summaries: [],
      messages: [
        {
          messageId: message.messageId,
          role: message.role,
          source: message.source,
          roomId: message.roomId,
          roomTitle: message.roomTitle,
          content: getPromptFacingMessageContent(message),
          createdAt: message.createdAt,
        },
      ],
      truncated: false,
    };
  }

  if (parsed.type === "summary") {
    const description = await getAgentContextSummaryDescription(args.agentId, parsed.value);
    if (!description) {
      return null;
    }
    const result: MemoryExpandResult = {
      handle: args.handle,
      type: "summary",
      summaries: [],
      messages: [],
      truncated: false,
    };
    await expandSummaryRecursive({
      agentId: args.agentId,
      description,
      depth,
      includeMessages,
      maxItems,
      seenSummaryIds: new Set<string>(),
      result,
    });
    return result;
  }

  const file = await readAgentMemoryFile({
    agentId: args.agentId,
    relPath: parsed.value,
    lines: 60,
  }).catch(() => null);
  if (!file) {
    return null;
  }
  return {
    handle: args.handle,
    type: "file",
    summaries: [],
    messages: [
      {
        messageId: file.path,
        role: "file",
        source: "legacy_memory",
        roomId: null,
        roomTitle: null,
        content: file.text,
        createdAt: "",
      },
    ],
    truncated: false,
  };
}

export async function readAgentMemoryHandle(args: {
  agentId: RoomAgentId;
  handleOrPath: string;
  from?: number;
  lines?: number;
}): Promise<MemoryFileSlice | MemoryDescribeResult | null> {
  const parsed = parseHandle(args.handleOrPath);
  if (!parsed) {
    return readAgentMemoryFile({
      agentId: args.agentId,
      relPath: args.handleOrPath,
      from: args.from,
      lines: args.lines,
    }).catch(() => null);
  }

  if (parsed.type === "file") {
    return readAgentMemoryFile({
      agentId: args.agentId,
      relPath: parsed.value,
      from: args.from,
      lines: args.lines,
    }).catch(() => null);
  }

  return describeAgentMemoryHandle(args.agentId, args.handleOrPath);
}
