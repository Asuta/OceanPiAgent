import type { MemoryBackendId, RoomAgentId, ToolExecution } from "@/lib/chat/types";

export interface MemorySearchResult {
  handle?: string;
  type?: "message" | "summary" | "file";
  id?: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  roomId?: string | null;
  roomTitle?: string | null;
  source?: string;
  createdAt?: string;
}

export interface MemoryFileSlice {
  path: string;
  from: number;
  lines: number;
  text: string;
}

export interface AgentMemorySummary {
  fileCount: number;
  hasTimeline: boolean;
  hasCompactions: boolean;
}

export type AgentMemoryBackendId = MemoryBackendId;

export interface AgentMemoryStatus extends AgentMemorySummary {
  backend: AgentMemoryBackendId;
  documentCount?: number;
  chunkCount?: number;
  lastIndexedAt?: string;
  dirty: boolean;
  missingIndex: boolean;
  fallbackReason?: string;
}

export interface AgentMemoryIndexResult {
  backend: AgentMemoryBackendId;
  mode: "full" | "incremental";
  indexedDocuments: number;
  removedDocuments: number;
  chunkCount?: number;
  durationMs: number;
  fallbackReason?: string;
}

export interface AgentMemorySearchOptions {
  maxResults?: number;
  minScore?: number;
}

export interface AppendAgentTurnMemoryArgs {
  agentId: RoomAgentId;
  roomId: string;
  roomTitle: string;
  userMessageId: string;
  senderName: string;
  userContent: string;
  assistantContent: string;
  tools: ToolExecution[];
  emittedMessages: Array<{ roomId: string; content: string; kind: string; status: string; final: boolean }>;
  resolvedModel: string;
}

export interface AppendAgentCompactionMemoryArgs {
  agentId: RoomAgentId;
  summary: string;
  reason: string;
  prunedMessages: number;
  charsBefore: number;
  charsAfter: number;
}

export interface ReadAgentMemoryFileArgs {
  agentId: RoomAgentId;
  relPath: string;
  from?: number;
  lines?: number;
}

export interface MemoryDescribeResult {
  handle: string;
  type: "message" | "summary" | "file";
  message?: {
    messageId: number;
    role: string;
    content: string;
    createdAt: string;
  };
  summary?: {
    summaryId: string;
    kind: string;
    depth: number;
    content: string;
    createdAt: string;
    tokenCount: number;
    parentIds: string[];
    childIds: string[];
    messageIds: number[];
    descendantCount?: number;
    descendantTokenCount?: number;
    sourceMessageTokenCount?: number;
    fileIds?: string[];
    subtree?: Array<{
      summaryId: string;
      parentSummaryId: string | null;
      depthFromRoot: number;
      kind: string;
      depth: number;
      tokenCount: number;
      descendantCount: number;
      descendantTokenCount: number;
      sourceMessageTokenCount: number;
      earliestAt?: string | null;
      latestAt?: string | null;
      childCount: number;
      path: string;
    }>;
  };
  file?: MemoryFileSlice & {
    fileId?: string;
    mimeType?: string | null;
    byteSize?: number | null;
    storageUri?: string;
    explorationSummary?: string | null;
    createdAt?: string;
  };
}

export interface MemoryExpandResult {
  handle: string;
  type: "message" | "summary" | "file";
  summaries: Array<{ summaryId: string; kind: string; content: string; tokenCount: number }>;
  messages: Array<{ messageId: number | string; role: string; content: string; tokenCount?: number; createdAt?: string }>;
  estimatedTokens: number;
  truncated: boolean;
}
