import type { RoomAgentId } from "@/lib/chat/types";
import type {
  AgentMemoryBackendId,
  AgentMemoryIndexResult,
  AgentMemorySearchOptions,
  AgentMemoryStatus,
  AgentMemorySummary,
  AppendAgentCompactionMemoryArgs,
  AppendAgentTurnMemoryArgs,
  MemoryFileSlice,
  MemorySearchResult,
  ReadAgentMemoryFileArgs,
} from "./types";

export interface AgentMemoryBackend {
  readonly id: AgentMemoryBackendId;
  appendTurnMemory(args: AppendAgentTurnMemoryArgs): Promise<void>;
  appendCompactionMemory(args: AppendAgentCompactionMemoryArgs): Promise<void>;
  search(agentId: RoomAgentId, query: string, options?: AgentMemorySearchOptions): Promise<MemorySearchResult[]>;
  readFile(args: ReadAgentMemoryFileArgs): Promise<MemoryFileSlice>;
  clear(agentId: RoomAgentId): Promise<void>;
  getSummary(agentId: RoomAgentId): Promise<AgentMemorySummary>;
  getStatus(agentId: RoomAgentId): Promise<AgentMemoryStatus>;
  reindex(agentId: RoomAgentId, options?: { force?: boolean }): Promise<AgentMemoryIndexResult>;
}
