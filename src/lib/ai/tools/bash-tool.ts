import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { bashArgsSchema, type ToolDefinition } from "./shared";

const MAX_STDIO_CHARS = 20_000;

function resolveCommandCwd(cwd?: string): string {
  if (!cwd) {
    return process.cwd();
  }

  return path.isAbsolute(cwd) ? cwd : path.resolve(process.cwd(), cwd);
}

function getShellPath(): string | true {
  if (process.platform === "win32") {
    return process.env.ComSpec || "cmd.exe";
  }

  return process.env.SHELL || "/bin/bash";
}

function appendChunk(current: string, chunk: string): { text: string; truncated: boolean } {
  if (current.length >= MAX_STDIO_CHARS) {
    return { text: current, truncated: true };
  }

  const remaining = MAX_STDIO_CHARS - current.length;
  if (chunk.length <= remaining) {
    return { text: current + chunk, truncated: false };
  }

  return {
    text: current + chunk.slice(0, remaining),
    truncated: true,
  };
}

function formatStreamOutput(label: string, value: string, truncated: boolean): string {
  if (!value) {
    return `${label}:\n[empty]`;
  }

  return truncated ? `${label} (truncated to ${MAX_STDIO_CHARS} chars):\n${value}` : `${label}:\n${value}`;
}

function formatCommandResult(args: z.infer<typeof bashArgsSchema>, cwd: string, shell: string | true, exitCode: number | null, stdout: string, stderr: string, stdoutTruncated: boolean, stderrTruncated: boolean): string {
  const shellLabel = shell === true ? "default shell" : shell;

  return [
    `Command: ${args.command}`,
    `Shell: ${shellLabel}`,
    `Cwd: ${cwd}`,
    `Exit code: ${exitCode ?? "unknown"}`,
    formatStreamOutput("Stdout", stdout, stdoutTruncated),
    formatStreamOutput("Stderr", stderr, stderrTruncated),
  ].join("\n\n");
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
    const shell = getShellPath();

    return await new Promise<string>((resolve, reject) => {
      const child = spawn(args.command, {
        cwd,
        env: process.env,
        shell,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", handleAbort);
      };

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        callback();
      };

      const handleAbort = () => {
        child.kill();
        settle(() => reject(new Error("Command aborted.")));
      };

      const timeoutId = setTimeout(() => {
        child.kill();
        settle(() => reject(new Error(`Command timed out after ${args.timeoutMs}ms.`)));
      }, args.timeoutMs);

      signal?.addEventListener("abort", handleAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const next = appendChunk(stdout, chunk.toString());
        stdout = next.text;
        stdoutTruncated ||= next.truncated;
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        const next = appendChunk(stderr, chunk.toString());
        stderr = next.text;
        stderrTruncated ||= next.truncated;
      });

      child.on("error", (error) => {
        settle(() => reject(error));
      });

      child.on("close", (code) => {
        const output = formatCommandResult(args, cwd, shell, code, stdout, stderr, stdoutTruncated, stderrTruncated);
        if (code === 0) {
          settle(() => resolve(output));
          return;
        }

        settle(() => reject(new Error(output)));
      });
    });
  },
} satisfies ToolDefinition<unknown>;
