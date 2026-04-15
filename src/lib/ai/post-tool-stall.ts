import type { ToolExecution } from "@/lib/chat/types";

const DEFAULT_POST_TOOL_STALL_ABORT_MS = 20_000;
const DEFAULT_TOOL_CALL_STALL_ABORT_MS = 20_000;
const DEFAULT_POST_TOOL_COMPACTION_ABORT_MS = 20_000;

export interface PostToolStallAbortController {
  arm: (toolEvent: ToolExecution) => void;
  pause: () => void;
  resume: () => void;
  clear: () => void;
  getMessage: () => string;
}

export interface ToolCallStallAbortController {
  arm: (toolName: string) => void;
  clear: () => void;
  getMessage: () => string;
}

export interface PostToolCompactionTimeoutController {
  signal: AbortSignal;
  clear: () => void;
  timedOut: () => boolean;
  getMessage: () => string;
}

function formatToolDisplayName(toolName: string): string {
  return toolName
    .trim()
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Unknown Tool";
}

export function getPostToolStallAbortMs(): number {
  const raw = process.env.OCEANKING_POST_TOOL_STALL_ABORT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POST_TOOL_STALL_ABORT_MS;
}

export function getToolCallStallAbortMs(): number {
  const raw = process.env.OCEANKING_TOOLCALL_STALL_ABORT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return getPostToolStallAbortMs() || DEFAULT_TOOL_CALL_STALL_ABORT_MS;
}

export function getPostToolCompactionAbortMs(): number {
  const raw = process.env.OCEANKING_POST_TOOL_COMPACTION_ABORT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return getPostToolStallAbortMs() || DEFAULT_POST_TOOL_COMPACTION_ABORT_MS;
}

export function createPostToolStallAbortController(args: {
  abort: () => void;
  getStallMs?: () => number;
}): PostToolStallAbortController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stallMessage = "";
  let lastToolEvent: ToolExecution | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const armTimer = (toolEvent: ToolExecution) => {
    clearTimer();
    const stallMs = (args.getStallMs ?? getPostToolStallAbortMs)();
    timer = setTimeout(() => {
      stallMessage = `Model stalled for ${stallMs} ms after completing tool ${toolEvent.displayName}.`;
      args.abort();
    }, stallMs);
  };

  return {
    arm(toolEvent) {
      lastToolEvent = toolEvent;
      stallMessage = "";
      armTimer(toolEvent);
    },
    pause() {
      clearTimer();
    },
    resume() {
      if (!lastToolEvent) {
        return;
      }

      stallMessage = "";
      armTimer(lastToolEvent);
    },
    clear() {
      clearTimer();
      stallMessage = "";
      lastToolEvent = null;
    },
    getMessage() {
      return stallMessage;
    },
  };
}

export function createToolCallStallAbortController(args: {
  abort: () => void;
  getStallMs?: () => number;
}): ToolCallStallAbortController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stallMessage = "";

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    arm(toolName) {
      clearTimer();
      const displayName = formatToolDisplayName(toolName);
      const stallMs = (args.getStallMs ?? getToolCallStallAbortMs)();
      stallMessage = "";
      timer = setTimeout(() => {
        stallMessage = `Model stalled for ${stallMs} ms while streaming tool ${displayName}.`;
        args.abort();
      }, stallMs);
    },
    clear() {
      clearTimer();
      stallMessage = "";
    },
    getMessage() {
      return stallMessage;
    },
  };
}

export function createPostToolCompactionTimeoutController(args: {
  signal?: AbortSignal;
  getTimeoutMs?: () => number;
}): PostToolCompactionTimeoutController {
  const timeoutController = new AbortController();
  const timeoutMs = (args.getTimeoutMs ?? getPostToolCompactionAbortMs)();
  let timedOut = false;
  let timeoutMessage = "";
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutMessage = `Post-tool compaction timed out after ${timeoutMs} ms.`;
    timeoutController.abort(new Error(timeoutMessage));
  }, timeoutMs);

  return {
    signal: args.signal ? AbortSignal.any([args.signal, timeoutController.signal]) : timeoutController.signal,
    clear() {
      clearTimeout(timer);
    },
    timedOut() {
      return timedOut;
    },
    getMessage() {
      return timeoutMessage;
    },
  };
}

export const __testing = {
  createPostToolStallAbortController,
  createToolCallStallAbortController,
  createPostToolCompactionTimeoutController,
};
