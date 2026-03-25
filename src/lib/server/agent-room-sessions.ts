import { appendAgentTurnMemory } from "./agent-memory-store";
import {
  compactPersistedAgentRuntime,
  finalizePersistedAgentRuntime,
  loadPersistedAgentRuntime,
  resetPersistedAgentRuntime,
  savePersistedAgentRuntime,
  type PersistedVisibleMessage,
} from "./agent-runtime-store";
import type {
  ProviderCompatibility,
  RoomAgentId,
  RoomMessageEmission,
  RoomToolActionUnion,
  RoomSender,
  ToolExecution,
} from "@/lib/chat/types";

type VisibleMessage = {
  role: "user" | "assistant";
  content: string;
};

interface AgentRuntimeRun {
  requestId: string;
  roomId: string;
  roomTitle: string;
  userMessageId: string;
  userSender: RoomSender;
  userContent: string;
  assistantContent: string;
  toolEvents: ToolExecution[];
  emittedMessages: RoomMessageEmission[];
  roomActions: RoomToolActionUnion[];
  abortController: AbortController;
}

interface AttachedRoomDescriptor {
  id: string;
  title: string;
  archived?: boolean;
}

interface AgentRuntimeSession {
  history: PersistedVisibleMessage[];
  activeRun?: AgentRuntimeRun;
  resolvedModel: string;
  compatibility: ProviderCompatibility | null;
  updatedAt: string;
  loaded: boolean;
}

declare global {
  var __oceankingAgentRoomSessions: Map<RoomAgentId, AgentRuntimeSession> | undefined;
}

const agentSessions = globalThis.__oceankingAgentRoomSessions ?? new Map<RoomAgentId, AgentRuntimeSession>();
globalThis.__oceankingAgentRoomSessions = agentSessions;

const ROOM_KIND_LABELS: Record<RoomMessageEmission["kind"], string> = {
  answer: "answer",
  progress: "progress",
  warning: "warning",
  error: "error",
  clarification: "clarification",
};

function createTimestamp(): string {
  return new Date().toISOString();
}

function getOrCreateSession(agentId: RoomAgentId): AgentRuntimeSession {
  const existing = agentSessions.get(agentId);
  if (existing) {
    return existing;
  }

  const created: AgentRuntimeSession = {
    history: [],
    resolvedModel: "",
    compatibility: null,
    updatedAt: createTimestamp(),
    loaded: false,
  };
  agentSessions.set(agentId, created);
  return created;
}

async function hydrateSession(agentId: RoomAgentId): Promise<AgentRuntimeSession> {
  const session = getOrCreateSession(agentId);
  if (session.loaded) {
    return session;
  }

  const persisted = await loadPersistedAgentRuntime(agentId);
  session.history = persisted.history;
  session.resolvedModel = persisted.resolvedModel;
  session.compatibility = persisted.compatibility;
  session.updatedAt = persisted.updatedAt;
  session.loaded = true;
  return session;
}

async function persistSession(agentId: RoomAgentId): Promise<void> {
  const session = getOrCreateSession(agentId);
  await savePersistedAgentRuntime({
    version: 1,
    agentId,
    history: session.history,
    compactions: (await loadPersistedAgentRuntime(agentId)).compactions,
    resolvedModel: session.resolvedModel,
    compatibility: session.compatibility,
    updatedAt: session.updatedAt,
  });
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trim()}...`;
}

function formatAttachedRooms(attachedRooms: AttachedRoomDescriptor[], currentRoomId: string): string {
  if (attachedRooms.length === 0) {
    return "- none supplied";
  }

  return attachedRooms
    .map((room, index) => {
      const markers = [room.id === currentRoomId ? "current" : null, room.archived ? "archived" : "routable"]
        .filter(Boolean)
        .join(", ");
      return `${index + 1}. ${room.title} (roomId: ${room.id}; ${markers})`;
    })
    .join("\n");
}

function buildIncomingRoomEnvelope(
  roomId: string,
  roomTitle: string,
  messageId: string,
  sender: RoomSender,
  content: string,
  attachedRooms: AttachedRoomDescriptor[],
): string {
  return [
    "[Incoming Chat Room message]",
    "All rooms attached to this agent intentionally share one memory space and belong to the same operator unless a user explicitly asks for isolation.",
    `Room ID: ${roomId}`,
    `Room Title: ${roomTitle}`,
    `Message ID: ${messageId}`,
    `Sender ID: ${sender.id}`,
    `Sender Name: ${sender.name}`,
    `Sender Role: ${sender.role}`,
    "Currently attached rooms for this agent:",
    formatAttachedRooms(attachedRooms, roomId),
    "Visible room message:",
    content,
  ].join("\n");
}

function buildContinuationSnapshot(run: AgentRuntimeRun): string {
  const sections = [
    "[Continuation snapshot from an unfinished shared agent run]",
    `Current room context: ${run.roomTitle} (${run.roomId})`,
    `Original user message id: ${run.userMessageId}`,
    `Original sender: ${run.userSender.name} (${run.userSender.id}, ${run.userSender.role})`,
    `Original room message:\n${run.userContent}`,
  ];

  if (run.emittedMessages.length > 0) {
    sections.push(
      [
        "Room-visible deliveries already sent:",
        ...run.emittedMessages.slice(-8).map(
          (message) =>
            `- to room ${message.roomId}: [${ROOM_KIND_LABELS[message.kind]} / ${message.status}${message.final ? " / final" : ""}] ${message.content}`,
        ),
      ].join("\n"),
    );
  }

  if (run.roomActions.length > 0) {
    sections.push(["Room actions already taken:", ...run.roomActions.map((action) => `- ${formatRoomAction(action)}`)].join("\n"));
  }

  if (run.toolEvents.length > 0) {
    sections.push(
      [
        "Completed tool work so far:",
        ...run.toolEvents.slice(-8).map((tool) => `- ${tool.displayName}: ${truncateText(tool.resultPreview, 260)}`),
      ].join("\n"),
    );
  }

  if (run.assistantContent.trim()) {
    sections.push(`Partial internal draft (incomplete; use only as context):\n${truncateText(run.assistantContent, 1_400)}`);
  }

  sections.push(
    [
      "A newer room message has now arrived.",
      "You still have an unfinished obligation in this earlier room unless the newer message explicitly canceled it.",
      "Treat the newer room update as new information, not as automatic permission to abandon this earlier room.",
      "Before ending the current turn, either complete this earlier room's obligation or send a visible progress update there if work is still ongoing.",
      "Keep all cross-room context in mind, and remember that these rooms intentionally share memory unless the user explicitly asks for isolation.",
    ].join(" "),
  );

  return sections.join("\n\n");
}

function buildAssistantHistoryEntry(run: AgentRuntimeRun, assistantText: string): string {
  const trimmedAssistantText = assistantText.trim();
  const sections: string[] = [];

  if (trimmedAssistantText) {
    sections.push(trimmedAssistantText);
  }

  if (!trimmedAssistantText) {
    sections.push("[Shared agent room action summary]");
  }

  if (run.emittedMessages.length > 0) {
    sections.push(
      [
        "Visible room deliveries:",
        ...run.emittedMessages.map(
          (message) =>
            `- to room ${message.roomId}: [${ROOM_KIND_LABELS[message.kind]} / ${message.status}${message.final ? " / final" : ""}] ${message.content}`,
        ),
      ].join("\n"),
    );
  }

  if (run.roomActions.length > 0) {
    sections.push(["Room actions:", ...run.roomActions.map((action) => `- ${formatRoomAction(action)}`)].join("\n"));
  }

  if (run.toolEvents.length > 0) {
    sections.push(
      [
        "Tool results used:",
        ...run.toolEvents.slice(-6).map((tool) => `- ${tool.displayName}: ${truncateText(tool.resultPreview, 260)}`),
      ].join("\n"),
    );
  }

  return sections.join("\n\n").trim();
}

function formatRoomAction(action: RoomToolActionUnion): string {
  if (action.type === "read_no_reply") {
    return `${action.type} for room ${action.roomId}, message ${action.messageId}`;
  }

  if (action.type === "create_room") {
    return `${action.type} created room ${action.roomId} (${action.title}) with agents ${action.agentIds.join(", ") || "none"}`;
  }

  if (action.type === "add_agents_to_room") {
    return `${action.type} for room ${action.roomId}, agents ${action.agentIds.join(", ") || "none"}`;
  }

  if (action.type === "remove_room_participant") {
    return `${action.type} for room ${action.roomId}, participant ${action.participantId}`;
  }

  return `${action.type} for room ${action.roomId}`;
}

function toVisibleHistory(history: PersistedVisibleMessage[]): VisibleMessage[] {
  return history.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export async function startAgentRoomRun(args: {
  agentId: RoomAgentId;
  roomId: string;
  roomTitle: string;
  attachedRooms: AttachedRoomDescriptor[];
  userMessageId: string;
  userSender: RoomSender;
  userContent: string;
  requestSignal: AbortSignal;
}) {
  const session = await hydrateSession(args.agentId);
  const previousRun = session.activeRun;
  const continuationSnapshot = previousRun ? buildContinuationSnapshot(previousRun) : undefined;

  if (previousRun && continuationSnapshot) {
    session.history.push({
      id: crypto.randomUUID(),
      role: "assistant",
      content: continuationSnapshot,
      createdAt: createTimestamp(),
    });
    session.updatedAt = createTimestamp();
    await persistSession(args.agentId);
  }

  const compactResult = await compactPersistedAgentRuntime({
    agentId: args.agentId,
    reason: "automatic",
  });
  if (compactResult.compacted) {
    session.history = compactResult.history;
    session.updatedAt = createTimestamp();
  }

  const requestId = crypto.randomUUID();
  const abortController = new AbortController();
  const signal = AbortSignal.any([args.requestSignal, abortController.signal]);

  const incomingMessage: PersistedVisibleMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: buildIncomingRoomEnvelope(
      args.roomId,
      args.roomTitle,
      args.userMessageId,
      args.userSender,
      args.userContent,
      args.attachedRooms,
    ),
    createdAt: createTimestamp(),
  };

  session.history.push(incomingMessage);
  session.activeRun = {
    requestId,
    roomId: args.roomId,
    roomTitle: args.roomTitle,
    userMessageId: args.userMessageId,
    userSender: args.userSender,
    userContent: args.userContent,
    assistantContent: "",
    toolEvents: [],
    emittedMessages: [],
    roomActions: [],
    abortController,
  };
  session.updatedAt = createTimestamp();
  await persistSession(args.agentId);

  previousRun?.abortController.abort(new Error("Superseded by a newer room message."));

  return {
    requestId,
    signal,
    history: toVisibleHistory(session.history),
    compatibility: session.compatibility,
    resolvedModel: session.resolvedModel,
    continuationSnapshot,
  };
}

export function isCurrentAgentRun(agentId: RoomAgentId, requestId: string): boolean {
  return getOrCreateSession(agentId).activeRun?.requestId === requestId;
}

export function hasActiveAgentRoomRun(agentId: RoomAgentId): boolean {
  return Boolean(getOrCreateSession(agentId).activeRun);
}

export function recordAgentTextDelta(agentId: RoomAgentId, requestId: string, delta: string): void {
  const run = getOrCreateSession(agentId).activeRun;
  if (!run || run.requestId !== requestId) {
    return;
  }

  run.assistantContent += delta;
}

export function recordAgentToolEvent(agentId: RoomAgentId, requestId: string, tool: ToolExecution): void {
  const run = getOrCreateSession(agentId).activeRun;
  if (!run || run.requestId !== requestId) {
    return;
  }

  run.toolEvents.push(tool);
  if (tool.roomMessage) {
    run.emittedMessages.push(tool.roomMessage);
  }
  if (tool.roomAction) {
    run.roomActions.push(tool.roomAction);
  }
}

export async function completeAgentRoomRun(args: {
  agentId: RoomAgentId;
  requestId: string;
  assistantText: string;
  resolvedModel: string;
  compatibility: ProviderCompatibility;
}): Promise<void> {
  const session = await hydrateSession(args.agentId);
  const run = session.activeRun;
  if (!run || run.requestId !== args.requestId) {
    return;
  }

  const assistantMessage: PersistedVisibleMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: buildAssistantHistoryEntry(run, args.assistantText),
    createdAt: createTimestamp(),
  };

  session.history.push(assistantMessage);
  session.activeRun = undefined;
  session.resolvedModel = args.resolvedModel;
  session.compatibility = args.compatibility;
  session.updatedAt = createTimestamp();
  await finalizePersistedAgentRuntime({
    agentId: args.agentId,
    assistantMessage,
    resolvedModel: args.resolvedModel,
    compatibility: args.compatibility,
  });
  await appendAgentTurnMemory({
    agentId: args.agentId,
    roomId: run.roomId,
    roomTitle: run.roomTitle,
    userMessageId: run.userMessageId,
    senderName: run.userSender.name,
    userContent: run.userContent,
    assistantContent: args.assistantText,
    tools: run.toolEvents,
    emittedMessages: run.emittedMessages,
    resolvedModel: args.resolvedModel,
  });
}

export function clearAgentRoomRun(agentId: RoomAgentId, requestId: string): void {
  const session = getOrCreateSession(agentId);
  const run = session.activeRun;
  if (!run || run.requestId !== requestId) {
    return;
  }

  session.activeRun = undefined;
  session.updatedAt = createTimestamp();
}

export async function compactAgentRoomSession(agentId: RoomAgentId, reason: "automatic" | "manual" = "manual") {
  const session = await hydrateSession(agentId);
  const result = await compactPersistedAgentRuntime({
    agentId,
    reason,
    force: reason === "manual",
  });
  if (result.compacted) {
    session.history = result.history;
    session.updatedAt = createTimestamp();
  }

  return result;
}

export async function resetAgentRoomSession(agentId: RoomAgentId): Promise<void> {
  const session = getOrCreateSession(agentId);
  session.activeRun?.abortController.abort(new Error("Agent context reset by operator."));
  session.history = [];
  session.activeRun = undefined;
  session.resolvedModel = "";
  session.compatibility = null;
  session.updatedAt = createTimestamp();
  session.loaded = true;
  await resetPersistedAgentRuntime(agentId);
}
