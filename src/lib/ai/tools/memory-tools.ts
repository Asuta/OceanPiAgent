import { z } from "zod";
import { getAgentMemoryStatus, readAgentMemoryFile, reindexAgentMemory, searchAgentMemory } from "@/lib/server/agent-memory-store";
import {
  createStructuredOutput,
  getCurrentAgentId,
  getCurrentChatSettings,
  memoryGetArgsSchema,
  memoryIndexArgsSchema,
  memorySearchArgsSchema,
  memoryStatusArgsSchema,
  type ToolDefinition,
} from "./shared";

export const memoryTools = {
  memory_search: {
    name: "memory_search",
    displayName: "Memory Search",
    description:
      "Search the persisted agent memory store for prior room work, decisions, summaries, and tool outcomes before answering long-running or cross-room questions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "What prior context you are looking for." },
        maxResults: { type: "number", description: "Optional maximum number of memory hits to return. Defaults to 8." },
        minScore: { type: "number", description: "Optional minimum score threshold for returned memory hits." },
      },
      required: ["query"],
    },
    validate: (value: unknown) => memorySearchArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof memorySearchArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const backendId = getCurrentChatSettings(context)?.memoryBackend;
      const results = await searchAgentMemory(agentId, args.query, {
        backendId,
        maxResults: args.maxResults,
        minScore: args.minScore,
      });

      return createStructuredOutput({
        query: args.query,
        resultCount: results.length,
        results,
      });
    },
  } satisfies ToolDefinition<unknown>,
  memory_get: {
    name: "memory_get",
    displayName: "Memory Get",
    description:
      "Read a focused slice from a persisted agent memory markdown file after memory_search returns a useful path and line range.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "The memory file path returned by memory_search." },
        from: { type: "number", description: "Optional starting line number." },
        lines: { type: "number", description: "Optional number of lines to read. Defaults to 40." },
      },
      required: ["path"],
    },
    validate: (value: unknown) => memoryGetArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof memoryGetArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const backendId = getCurrentChatSettings(context)?.memoryBackend;
      const result = await readAgentMemoryFile({
        agentId,
        relPath: args.path,
        from: args.from,
        lines: args.lines,
      }, { backendId });

      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  memory_status: {
    name: "memory_status",
    displayName: "Memory Status",
    description:
      "Inspect the current agent memory backend, index health, and whether persisted memory is dirty or missing an index.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    validate: (value: unknown) => memoryStatusArgsSchema.parse(value),
    execute: async (_value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const agentId = getCurrentAgentId(context);
      const backendId = getCurrentChatSettings(context)?.memoryBackend;
      const result = await getAgentMemoryStatus(agentId, { backendId });

      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  memory_index: {
    name: "memory_index",
    displayName: "Memory Index",
    description:
      "Rebuild or refresh the current agent memory index after memory files change or when search results look stale.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        force: { type: "boolean", description: "Whether to force a full reindex instead of an incremental refresh." },
      },
    },
    validate: (value: unknown) => memoryIndexArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof memoryIndexArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const backendId = getCurrentChatSettings(context)?.memoryBackend;
      const result = await reindexAgentMemory(agentId, { force: args.force, backendId });

      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
};
