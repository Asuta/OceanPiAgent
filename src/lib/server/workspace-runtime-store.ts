import type { AgentRuntimeState, RoomAgentId, WorkspaceRuntimeState } from "@/lib/chat/types";
import { applyWorkspaceRuntimeStatePatch, createWorkspaceRuntimeStatePatch, type WorkspaceStreamEvent } from "@/lib/chat/workspace-stream";

type RuntimeEnvelope = {
  runtimeVersion: number;
  updatedAt: string;
  state: WorkspaceRuntimeState;
};

type PendingToolState = {
  toolCallId: string;
  toolName: string;
  roomId: string;
  turnId: string;
  startedAt: string;
  updatedAt: string;
};

type AgentRuntimeEntry = {
  agentId: RoomAgentId;
  pendingTools: Map<string, PendingToolState>;
};

declare global {
  var __oceankingWorkspaceRuntimeEnvelope: RuntimeEnvelope | undefined;
  var __oceankingWorkspaceRuntimeSubscribers: Map<string, (event: WorkspaceStreamEvent) => void> | undefined;
  var __oceankingWorkspaceRuntimeEntries: Map<RoomAgentId, AgentRuntimeEntry> | undefined;
}

const runtimeSubscribers = globalThis.__oceankingWorkspaceRuntimeSubscribers ?? new Map<string, (event: WorkspaceStreamEvent) => void>();
globalThis.__oceankingWorkspaceRuntimeSubscribers = runtimeSubscribers;

const runtimeEntries = globalThis.__oceankingWorkspaceRuntimeEntries ?? new Map<RoomAgentId, AgentRuntimeEntry>();
globalThis.__oceankingWorkspaceRuntimeEntries = runtimeEntries;

function createTimestamp(): string {
  return new Date().toISOString();
}

function createDefaultRuntimeState(): WorkspaceRuntimeState {
  return {
    agentStates: {},
  };
}

function createDefaultRuntimeEnvelope(): RuntimeEnvelope {
  return {
    runtimeVersion: 0,
    updatedAt: createTimestamp(),
    state: createDefaultRuntimeState(),
  };
}

function getRuntimeEnvelope(): RuntimeEnvelope {
  if (!globalThis.__oceankingWorkspaceRuntimeEnvelope) {
    globalThis.__oceankingWorkspaceRuntimeEnvelope = createDefaultRuntimeEnvelope();
  }

  return globalThis.__oceankingWorkspaceRuntimeEnvelope;
}

function cloneRuntimeState(state: WorkspaceRuntimeState): WorkspaceRuntimeState {
  return {
    agentStates: { ...state.agentStates },
  };
}

function selectVisibleToolState(agentId: RoomAgentId): AgentRuntimeState | undefined {
  const entry = runtimeEntries.get(agentId);
  if (!entry || entry.pendingTools.size === 0) {
    return undefined;
  }

  const latestTool = [...entry.pendingTools.values()]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  if (!latestTool) {
    return undefined;
  }

  return {
    agentId,
    roomId: latestTool.roomId,
    turnId: latestTool.turnId,
    toolCallId: latestTool.toolCallId,
    toolName: latestTool.toolName,
    status: "working",
    startedAt: latestTool.startedAt,
    updatedAt: latestTool.updatedAt,
  };
}

function rebuildRuntimeState(): WorkspaceRuntimeState {
  const nextState: WorkspaceRuntimeState = {
    agentStates: {},
  };

  for (const agentId of runtimeEntries.keys()) {
    const visibleState = selectVisibleToolState(agentId);
    if (visibleState) {
      nextState.agentStates[agentId] = visibleState;
    }
  }

  return nextState;
}

function broadcast(event: WorkspaceStreamEvent): void {
  for (const listener of runtimeSubscribers.values()) {
    listener(event);
  }
}

function commitRuntimeState(nextState: WorkspaceRuntimeState): RuntimeEnvelope {
  const previousEnvelope = getRuntimeEnvelope();
  const nextEnvelope: RuntimeEnvelope = {
    runtimeVersion: previousEnvelope.runtimeVersion + 1,
    updatedAt: createTimestamp(),
    state: nextState,
  };
  globalThis.__oceankingWorkspaceRuntimeEnvelope = nextEnvelope;

  broadcast({
    type: "runtime-patch",
    runtimeVersion: nextEnvelope.runtimeVersion,
    updatedAt: nextEnvelope.updatedAt,
    patch: createWorkspaceRuntimeStatePatch(previousEnvelope.state, nextEnvelope.state),
  });

  return nextEnvelope;
}

function ensureAgentEntry(agentId: RoomAgentId): AgentRuntimeEntry {
  const existing = runtimeEntries.get(agentId);
  if (existing) {
    return existing;
  }

  const entry: AgentRuntimeEntry = {
    agentId,
    pendingTools: new Map<string, PendingToolState>(),
  };
  runtimeEntries.set(agentId, entry);
  return entry;
}

export function loadWorkspaceRuntimeEnvelope(): RuntimeEnvelope {
  return {
    ...getRuntimeEnvelope(),
    state: cloneRuntimeState(getRuntimeEnvelope().state),
  };
}

export function subscribeWorkspaceRuntimeEvents(listener: (event: WorkspaceStreamEvent) => void): () => void {
  const subscriptionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  runtimeSubscribers.set(subscriptionId, listener);
  return () => {
    runtimeSubscribers.delete(subscriptionId);
  };
}

export function startAgentToolRuntime(args: {
  agentId: RoomAgentId;
  roomId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
}): RuntimeEnvelope {
  const entry = ensureAgentEntry(args.agentId);
  const existingTool = entry.pendingTools.get(args.toolCallId);
  const startedAt = existingTool?.startedAt ?? createTimestamp();
  entry.pendingTools.set(args.toolCallId, {
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    roomId: args.roomId,
    turnId: args.turnId,
    startedAt,
    updatedAt: createTimestamp(),
  });

  return commitRuntimeState(rebuildRuntimeState());
}

export function finishAgentToolRuntime(args: {
  agentId: RoomAgentId;
  toolCallId: string;
}): RuntimeEnvelope {
  const entry = runtimeEntries.get(args.agentId);
  if (!entry) {
    return loadWorkspaceRuntimeEnvelope();
  }

  entry.pendingTools.delete(args.toolCallId);
  if (entry.pendingTools.size === 0) {
    runtimeEntries.delete(args.agentId);
  }

  return commitRuntimeState(rebuildRuntimeState());
}

export function clearAgentRuntime(args: {
  agentId: RoomAgentId;
  roomId?: string;
  turnId?: string;
}): RuntimeEnvelope {
  const entry = runtimeEntries.get(args.agentId);
  if (!entry) {
    return loadWorkspaceRuntimeEnvelope();
  }

  if (!args.roomId && !args.turnId) {
    runtimeEntries.delete(args.agentId);
    return commitRuntimeState(rebuildRuntimeState());
  }

  for (const [toolCallId, pendingTool] of entry.pendingTools) {
    if (args.roomId && pendingTool.roomId !== args.roomId) {
      continue;
    }
    if (args.turnId && pendingTool.turnId !== args.turnId) {
      continue;
    }
    entry.pendingTools.delete(toolCallId);
  }

  if (entry.pendingTools.size === 0) {
    runtimeEntries.delete(args.agentId);
  }

  return commitRuntimeState(rebuildRuntimeState());
}

export function applyWorkspaceRuntimeStatePatchForTest(patch: Parameters<typeof applyWorkspaceRuntimeStatePatch>[1]): WorkspaceRuntimeState {
  return applyWorkspaceRuntimeStatePatch(loadWorkspaceRuntimeEnvelope().state, patch);
}

export function resetWorkspaceRuntimeStateForTest(): void {
  runtimeEntries.clear();
  globalThis.__oceankingWorkspaceRuntimeEnvelope = createDefaultRuntimeEnvelope();
}
