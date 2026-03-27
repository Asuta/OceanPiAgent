import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolExecutionDetails } from "@/lib/chat/types";

const DEFAULT_MAX_OUTPUT_LINES = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_ROLLING_BUFFER_BYTES = DEFAULT_MAX_OUTPUT_BYTES * 2;
const EXIT_STDIO_GRACE_MS = 100;

const ANSI_PATTERN = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  "g",
);

type OutputStream = "stdout" | "stderr";

interface ShellConfig {
  shell: string;
  args: string[];
}

interface TruncationResult {
  content: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
  lastLinePartial: boolean;
}

export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (stream: OutputStream, data: Buffer) => void;
      signal?: AbortSignal;
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null; shell: string }>;
}

export interface BashExecutionResult {
  stdout: string;
  stderr: string;
  details: ToolExecutionDetails;
}

export interface BashExecutionArgs {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  operations?: BashOperations;
}

function findBashOnPath(): string | null {
  try {
    const result = process.platform === "win32"
      ? spawnSync("where", ["bash.exe"], { encoding: "utf-8", timeout: 5_000 })
      : spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5_000 });

    if (result.status !== 0 || !result.stdout) {
      return null;
    }

    const firstMatch = result.stdout.trim().split(/\r?\n/u)[0];
    if (!firstMatch) {
      return null;
    }

    return process.platform === "win32" && !existsSync(firstMatch) ? null : firstMatch;
  } catch {
    return null;
  }
}

function getShellConfig(): ShellConfig {
  if (process.platform === "win32") {
    const gitBashCandidates = [
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : undefined,
      process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe") : undefined,
      process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : undefined,
      findBashOnPath(),
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of gitBashCandidates) {
      if (existsSync(candidate)) {
        return { shell: candidate, args: ["-c"] };
      }
    }

    return {
      shell: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c"],
    };
  }

  if (process.env.SHELL) {
    return { shell: process.env.SHELL, args: ["-c"] };
  }

  if (existsSync("/bin/bash")) {
    return { shell: "/bin/bash", args: ["-c"] };
  }

  return { shell: findBashOnPath() || "sh", args: ["-c"] };
}

function sanitizeOutput(text: string): string {
  const withoutAnsi = text.replace(ANSI_PATTERN, "").replace(/\r/g, "");

  return Array.from(withoutAnsi)
    .filter((char) => {
      const code = char.codePointAt(0);

      if (code === undefined) {
        return false;
      }

      if (code === 0x09 || code === 0x0a || code === 0x0d) {
        return true;
      }

      if (code <= 0x1f) {
        return false;
      }

      if (code >= 0xfff9 && code <= 0xfffb) {
        return false;
      }

      return true;
    })
    .join("");
}

function appendRollingChunk(chunks: string[], chunk: string, state: { bytes: number }) {
  if (!chunk) {
    return;
  }

  chunks.push(chunk);
  state.bytes += Buffer.byteLength(chunk, "utf-8");

  while (state.bytes > MAX_ROLLING_BUFFER_BYTES && chunks.length > 1) {
    const removed = chunks.shift();
    if (!removed) {
      break;
    }

    state.bytes -= Buffer.byteLength(removed, "utf-8");
  }
}

function truncateStringToBytesFromEnd(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf-8");
  if (buffer.length <= maxBytes) {
    return text;
  }

  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }

  return buffer.slice(start).toString("utf-8");
}

function truncateTail(content: string): TruncationResult {
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");

  if (lines.length <= DEFAULT_MAX_OUTPUT_LINES && totalBytes <= DEFAULT_MAX_OUTPUT_BYTES) {
    return {
      content,
      truncated: false,
      totalLines: lines.length,
      outputLines: lines.length,
      lastLinePartial: false,
    };
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  let lastLinePartial = false;

  for (let index = lines.length - 1; index >= 0 && outputLines.length < DEFAULT_MAX_OUTPUT_LINES; index -= 1) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLines.length > 0 ? 1 : 0);

    if (outputBytes + lineBytes > DEFAULT_MAX_OUTPUT_BYTES) {
      if (outputLines.length === 0) {
        outputLines.unshift(truncateStringToBytesFromEnd(line, DEFAULT_MAX_OUTPUT_BYTES));
        lastLinePartial = true;
      }
      break;
    }

    outputLines.unshift(line);
    outputBytes += lineBytes;
  }

  return {
    content: outputLines.join("\n"),
    truncated: true,
    totalLines: lines.length,
    outputLines: outputLines.length,
    lastLinePartial,
  };
}

function getTempFilePath(): string {
  return path.join(tmpdir(), `oceanking-bash-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // Ignore best-effort kill failures.
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Fall back to killing the direct child below.
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process is already gone.
  }
}

function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }

      child.removeListener("error", handleError);
      child.removeListener("exit", handleExit);
      child.removeListener("close", handleClose);
      child.stdout?.removeListener("end", handleStdoutEnd);
      child.stderr?.removeListener("end", handleStderrEnd);
    };

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      callback();
    };

    const maybeFinalize = () => {
      if (!exited || settled) {
        return;
      }

      if (stdoutEnded && stderrEnded) {
        settle(() => resolve(exitCode));
      }
    };

    const handleStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalize();
    };

    const handleStderrEnd = () => {
      stderrEnded = true;
      maybeFinalize();
    };

    const handleError = (error: Error) => {
      settle(() => reject(error));
    };

    const handleExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalize();

      if (!settled) {
        postExitTimer = setTimeout(() => {
          settle(() => resolve(code));
        }, EXIT_STDIO_GRACE_MS);
      }
    };

    const handleClose = (code: number | null) => {
      settle(() => resolve(code));
    };

    child.stdout?.once("end", handleStdoutEnd);
    child.stderr?.once("end", handleStderrEnd);
    child.once("error", handleError);
    child.once("exit", handleExit);
    child.once("close", handleClose);
  });
}

export function createLocalBashOperations(): BashOperations {
  return {
    exec(command, cwd, { onData, signal, timeoutMs, env }) {
      return new Promise((resolve, reject) => {
        if (!existsSync(cwd)) {
          reject(new Error(`Working directory does not exist: ${cwd}`));
          return;
        }

        const shellConfig = getShellConfig();
        const child = spawn(shellConfig.shell, [...shellConfig.args, command], {
          cwd,
          detached: true,
          env: env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });

        let timedOut = false;
        let timeoutId: NodeJS.Timeout | undefined;

        const cleanup = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }
          signal?.removeEventListener("abort", handleAbort);
        };

        const handleAbort = () => {
          if (child.pid) {
            killProcessTree(child.pid);
          }
        };

        if (timeoutMs && timeoutMs > 0) {
          timeoutId = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              killProcessTree(child.pid);
            }
          }, timeoutMs);
        }

        child.stdout?.on("data", (chunk: Buffer) => onData("stdout", chunk));
        child.stderr?.on("data", (chunk: Buffer) => onData("stderr", chunk));

        if (signal) {
          if (signal.aborted) {
            handleAbort();
          } else {
            signal.addEventListener("abort", handleAbort, { once: true });
          }
        }

        waitForChildProcess(child)
          .then((exitCode) => {
            cleanup();

            if (signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }

            if (timedOut) {
              reject(new Error(`timeout:${timeoutMs}`));
              return;
            }

            resolve({ exitCode, shell: shellConfig.shell });
          })
          .catch((error) => {
            cleanup();
            reject(error);
          });
      });
    },
  };
}

export async function executeBashCommand(args: BashExecutionArgs): Promise<BashExecutionResult> {
  const operations = args.operations ?? createLocalBashOperations();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const combinedChunks: string[] = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  const combinedState = { bytes: 0 };
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  let combinedBytesSeen = 0;
  let tempFilePath: string | undefined;
  let tempFileStream: WriteStream | undefined;
  let shell = "";

  const appendText = (stream: OutputStream, text: string) => {
    if (!text) {
      return;
    }

    combinedBytesSeen += Buffer.byteLength(text, "utf-8");
    if (combinedBytesSeen > DEFAULT_MAX_OUTPUT_BYTES && !tempFilePath) {
      tempFilePath = getTempFilePath();
      tempFileStream = createWriteStream(tempFilePath);
      for (const chunk of combinedChunks) {
        tempFileStream.write(chunk);
      }
    }

    if (tempFileStream) {
      tempFileStream.write(text);
    }

    appendRollingChunk(combinedChunks, text, combinedState);

    if (stream === "stdout") {
      appendRollingChunk(stdoutChunks, text, stdoutState);
      return;
    }

    appendRollingChunk(stderrChunks, text, stderrState);
  };

  const flushDecoder = (stream: OutputStream, decoder: TextDecoder) => {
    appendText(stream, sanitizeOutput(decoder.decode()));
  };

  try {
    const result = await operations.exec(args.command, args.cwd, {
      onData: (stream, data) => {
        const decoder = stream === "stdout" ? stdoutDecoder : stderrDecoder;
        appendText(stream, sanitizeOutput(decoder.decode(data, { stream: true })));
      },
      signal: args.signal,
      timeoutMs: args.timeoutMs,
      env: process.env,
    });

    shell = result.shell;
    flushDecoder("stdout", stdoutDecoder);
    flushDecoder("stderr", stderrDecoder);
    tempFileStream?.end();

    const stdout = truncateTail(stdoutChunks.join(""));
    const stderr = truncateTail(stderrChunks.join(""));

    return {
      stdout: stdout.content,
      stderr: stderr.content,
      details: {
        cwd: args.cwd,
        shell,
        exitCode: result.exitCode,
        truncated: stdout.truncated || stderr.truncated,
        fullOutputPath: tempFilePath,
      },
    };
  } catch (error) {
    flushDecoder("stdout", stdoutDecoder);
    flushDecoder("stderr", stderrDecoder);
    tempFileStream?.end();

    const stdout = truncateTail(stdoutChunks.join(""));
    const stderr = truncateTail(stderrChunks.join(""));
    const message = error instanceof Error ? error.message : "unknown";

    return {
      stdout: stdout.content,
      stderr: stderr.content,
      details: {
        cwd: args.cwd,
        shell,
        exitCode: null,
        truncated: stdout.truncated || stderr.truncated,
        fullOutputPath: tempFilePath,
        timedOut: message.startsWith("timeout:"),
        aborted: message === "aborted",
      },
    };
  }
}

export function formatBashOutput(args: {
  command: string;
  timeoutMs: number;
  stdout: string;
  stderr: string;
  details: ToolExecutionDetails;
}): string {
  const lines = [
    `Command: ${args.command}`,
    `Shell: ${args.details.shell || "unknown"}`,
    `Cwd: ${args.details.cwd || process.cwd()}`,
    `Exit code: ${args.details.exitCode ?? "unknown"}`,
  ];

  if (args.details.timedOut) {
    lines.push(`Timed out after: ${args.timeoutMs}ms`);
  }

  if (args.details.aborted) {
    lines.push("Aborted: yes");
  }

  if (args.details.truncated) {
    lines.push("Truncated: yes");
  }

  if (args.details.fullOutputPath) {
    lines.push(`Full output file: ${args.details.fullOutputPath}`);
  }

  return [
    ...lines,
    formatStreamOutput("Stdout", args.stdout),
    formatStreamOutput("Stderr", args.stderr),
  ].join("\n\n");
}

function formatStreamOutput(label: string, value: string): string {
  if (!value) {
    return `${label}:\n[empty]`;
  }

  return `${label}:\n${value}`;
}
