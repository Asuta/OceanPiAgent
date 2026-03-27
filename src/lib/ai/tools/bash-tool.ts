import path from "node:path";
import { z } from "zod";
import { executeBashCommand, formatBashOutput } from "./bash-executor";
import { bashArgsSchema, ToolExecutionError, type ToolDefinition } from "./shared";

function resolveCommandCwd(cwd?: string): string {
  if (!cwd) {
    return process.cwd();
  }

  return path.isAbsolute(cwd) ? cwd : path.resolve(process.cwd(), cwd);
}

export const bashTool = {
  name: "bash",
  displayName: "Bash",
  description:
    "Run an unrestricted shell command on the server in the current workspace or a caller-provided directory and return stdout, stderr, and exit status.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute.",
      },
      cwd: {
        type: "string",
        description: "Optional working directory. Relative paths resolve from the server process cwd; absolute paths are allowed.",
      },
      timeoutMs: {
        type: "number",
        description: "Optional timeout in milliseconds. Defaults to 120000.",
      },
    },
    required: ["command"],
  },
  validate: (value: unknown) => bashArgsSchema.parse(value),
  execute: async (value: unknown, signal?: AbortSignal) => {
    const args = value as z.infer<typeof bashArgsSchema>;
    const cwd = resolveCommandCwd(args.cwd);
    const result = await executeBashCommand({
      command: args.command,
      cwd,
      timeoutMs: args.timeoutMs,
      signal,
    });
    const output = formatBashOutput({
      command: args.command,
      timeoutMs: args.timeoutMs,
      stdout: result.stdout,
      stderr: result.stderr,
      details: result.details,
    });

    if (result.details.exitCode === 0 && !result.details.timedOut && !result.details.aborted) {
      return {
        output,
        details: result.details,
      };
    }

    throw new ToolExecutionError(output, result.details);
  },
} satisfies ToolDefinition<unknown>;
