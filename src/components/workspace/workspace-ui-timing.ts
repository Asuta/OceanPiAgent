"use client";

export type WorkspaceUiTimingEntry = {
  phase: string;
  elapsedMs: number;
  details?: Record<string, string | number | boolean | null>;
};

declare global {
  interface Window {
    __oceankingWorkspaceUiTimingLog?: WorkspaceUiTimingEntry[];
  }
}

export function recordWorkspaceUiTiming(entry: WorkspaceUiTimingEntry) {
  if (typeof window === "undefined") {
    return;
  }
  window.__oceankingWorkspaceUiTimingLog = [...(window.__oceankingWorkspaceUiTimingLog ?? []), entry].slice(-200);
  console.info("[workspace-ui-timing]", entry);
}
