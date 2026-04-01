import { z } from "zod";
import { describeAgentMemory, expandAgentMemory, getAgentMemoryStatus, readAgentMemoryFile, reindexAgentMemory, searchAgentMemory } from "@/lib/server/agent-memory-store";
import {
  createStructuredOutput,
  getCurrentAgentId,
  getCurrentChatSettings,
  memoryDescribeArgsSchema,
  memoryExpandArgsSchema,
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
      "Read a focused structured memory handle directly, or fall back to a persisted markdown file slice after memory_search returns a useful path.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Legacy markdown path returned by memory_search." },
        handle: { type: "string", description: "Structured memory handle such as message:<id>, summary:<id>, or file:<path>." },
        from: { type: "number", description: "Optional starting line number." },
        lines: { type: "number", description: "Optional number of lines to read. Defaults to 40." },
      },
      anyOf: [{ required: ["path"] }, { required: ["handle"] }],
    },
    validate: (value: unknown) => memoryGetArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof memoryGetArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const backendId = getCurrentChatSettings(context)?.memoryBackend;
      if (args.handle) {
        const described = await describeAgentMemory(agentId, args.handle);
        if (!described) {
          throw new Error("Memory item not found.");
        }
        return createStructuredOutput(described);
      }

      const result = await readAgentMemoryFile({
        agentId,
        relPath: args.path || "",
        from: args.from,
        lines: args.lines,
      }, { backendId });

      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  memory_describe: {
    name: "memory_describe",
    displayName: "Memory Describe",
    description:
      "Describe a structured memory handle returned by memory_search so you can inspect summary lineage, depth, and covered source ids before expanding.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        handle: { type: "string", description: "Structured memory handle such as message:<id>, summary:<id>, or file:<path>." },
      },
      required: ["handle"],
    },
    validate: (value: unknown) => memoryDescribeArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof memoryDescribeArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await describeAgentMemory(agentId, args.handle);
      if (!result) {
        throw new Error("Memory handle not found.");
      }
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  memory_expand: {
    name: "memory_expand",
    displayName: "Memory Expand",
    description:
      "Expand a structured summary handle into parent summaries and source messages when compressed history still hides decisive details.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        handle: { type: "string", description: "Structured memory handle such as message:<id>, summary:<id>, or file:<path>." },
        depth: { type: "number", description: "How many summary-parent levels to expand." },
        includeMessages: { type: "boolean", description: "Whether to include source messages when available." },
        maxItems: { type: "number", description: "Maximum total summaries plus messages to return." },
      },
      required: ["handle"],
    },
    validate: (value: unknown) => memoryExpandArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof memoryExpandArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await expandAgentMemory(agentId, args);
      if (!result) {
        throw new Error("Memory handle not found.");
      }
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
