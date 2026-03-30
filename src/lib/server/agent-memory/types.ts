import type { MemoryBackendId, RoomAgentId, ToolExecution } from "@/lib/chat/types";

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
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
