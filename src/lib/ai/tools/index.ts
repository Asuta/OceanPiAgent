import { baseTools } from "./base-tools";
import { cronTools } from "./cron-tools";
import { memoryTools } from "./memory-tools";
import { roomTools } from "./room-tools";
import { ToolExecutionError, formatJsonOutput, type ToolDefinition, type ToolExecutionContext, type ToolName, type ToolRuntimeResult } from "./shared";
import { workspaceTools } from "./workspace-tools";
import type { ToolExecution, ToolScope } from "@/lib/chat/types";
import { truncateText } from "@/lib/shared/text";
import { createUuid } from "@/lib/utils/uuid";

function getToolDefinitions(scope: ToolScope = "default"): Partial<Record<ToolName, ToolDefinition<unknown>>> {
  if (scope === "room") {
    return {
      ...baseTools,
      ...roomTools,
      ...cronTools,
      ...memoryTools,
      ...workspaceTools,
    };
  }

  return {
    ...baseTools,
  };
}

function normalizeToolRuntimeResult(result: string | ToolRuntimeResult): ToolRuntimeResult {
  if (typeof result === "string") {
    return {
      output: result,
    };
  }

  return result;
}

export function getChatCompletionsTools(scope: ToolScope = "default") {
  return Object.values(getToolDefinitions(scope)).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export function getLegacyChatCompletionsFunctions(scope: ToolScope = "default") {
  return Object.values(getToolDefinitions(scope)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

export function getResponsesTools(scope: ToolScope = "default") {
  return Object.values(getToolDefinitions(scope)).map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

export async function executeTool(
  toolName: string,
  rawArgs: unknown,
  scope: ToolScope = "default",
  signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<{ output: string; event: ToolExecution; details?: ToolExecution["details"] }> {
  const toolMap = getToolDefinitions(scope);
  const tool = toolMap[toolName as ToolName];
  if (!tool) {
    const output = `Tool not found: ${toolName}`;
    return {
      output,
      event: {
        id: createUuid(),
        sequence: 0,
        toolName,
        displayName: toolName,
        inputSummary: truncateText(formatJsonOutput(rawArgs), 240),
        inputText: formatJsonOutput(rawArgs),
        resultPreview: output,
        outputText: output,
        status: "error",
        durationMs: 0,
      },
    };
  }

  try {
    const startedAt = performance.now();
    const parsedArgs = tool.validate(rawArgs);
    const executionResult = normalizeToolRuntimeResult(await tool.execute(parsedArgs, signal, context));
    const customCommandName =
      rawArgs && typeof rawArgs === "object" && "command" in rawArgs
        ? String((rawArgs as { command: unknown }).command)
        : undefined;

    return {
      output: executionResult.output,
      details: executionResult.details,
      event: {
        id: createUuid(),
        sequence: 0,
        toolName: tool.name,
        displayName:
          tool.name === "custom_command" && customCommandName
            ? `Custom Command · ${customCommandName}`
            : tool.displayName,
        inputSummary: truncateText(formatJsonOutput(parsedArgs), 240),
        inputText: formatJsonOutput(parsedArgs),
        resultPreview: truncateText(executionResult.output, 320),
        outputText: executionResult.output,
        status: "success",
        durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
        ...(executionResult.details ? { details: executionResult.details } : {}),
        ...(executionResult.roomMessage ? { roomMessage: executionResult.roomMessage } : {}),
        ...(executionResult.roomAction ? { roomAction: executionResult.roomAction } : {}),
      },
    };
  } catch (error) {
    const output = error instanceof Error ? error.message : "Tool execution failed.";
    const details = error instanceof ToolExecutionError ? error.details : undefined;
    const customCommandName =
      rawArgs && typeof rawArgs === "object" && "command" in rawArgs
        ? String((rawArgs as { command: unknown }).command)
        : undefined;

    return {
      output,
      details,
      event: {
        id: createUuid(),
        sequence: 0,
        toolName: tool.name,
        displayName:
          tool.name === "custom_command" && customCommandName
            ? `Custom Command · ${customCommandName}`
            : tool.displayName,
        inputSummary: truncateText(formatJsonOutput(rawArgs), 240),
        inputText: formatJsonOutput(rawArgs),
        resultPreview: output,
        outputText: output,
        status: "error",
        durationMs: 0,
        ...(details ? { details } : {}),
      },
    };
  }
}
