import { assembleAgentLcmContext, ingestCompletedRun, ingestContinuationSnapshot, ingestIncomingRoomEnvelope } from "./lcm/facade";
import {
  clearPostToolCompactionRunState,
  compactPersistedAgentRuntime,
  finalizePersistedAgentRuntime,
  loadPersistedAgentRuntime,
  resetPersistedAgentRuntime,
  savePersistedAgentRuntime,
  type PersistedVisibleMessage,
} from "./agent-runtime-store";
import { loadWorkspaceEnvelope } from "./workspace-store";
import { formatMessageForTranscript, summarizeImageAttachments } from "@/lib/chat/message-attachments";
import type {
  AssistantMessageMeta,
  MessageImageAttachment,
  ProviderCompatibility,
  RoomAgentId,
  RoomMessageEmission,
  RoomToolActionUnion,
  RoomSender,
  ToolExecution,
} from "@/lib/chat/types";
import { createUuid } from "@/lib/utils/uuid";

type VisibleMessage = {
  role: "user" | "assistant";
  content: string;
  attachments: MessageImageAttachment[];
  meta?: AssistantMessageMeta;
};

interface AgentRuntimeRun {
  requestId: string;
  roomId: string;
  roomTitle: string;
  userMessageId: string;
  incomingMessageContent: string;
  userSender: RoomSender;
  userContent: string;
  userAttachments: MessageImageAttachment[];
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
  skipNextLcmAssemble?: boolean;
  resolvedModel: string;
  compatibility: ProviderCompatibility | null;
  updatedAt: string;
  loaded: boolean;
}

export interface AgentRunStartupTiming {
  startedAt: number;
  hydrateMs: number;
  continuationMs: number;
  persistAndIngestMs: number;
  assembleMs: number;
  totalStartupMs: number;
  hadContinuationSnapshot: boolean;
}

function upsertEmittedRoomMessage(
  messages: RoomMessageEmission[],
  message: RoomMessageEmission,
): RoomMessageEmission[] {
  const targetKey = message.messageKey ?? null;
  const existingIndex = messages.findIndex((entry) => {
    if (targetKey && entry.messageKey === targetKey && entry.roomId === message.roomId) {
      return true;
    }
    return !targetKey && !entry.messageKey && entry.roomId === message.roomId && entry.content === message.content;
  });

  if (existingIndex < 0) {
    return [...messages, message];
  }

  const nextMessages = [...messages];
  nextMessages[existingIndex] = {
    ...nextMessages[existingIndex],
    ...message,
  };
  return nextMessages;
}

declare global {
  var __oceankingAgentRoomSessions: Map<RoomAgentId, AgentRuntimeSession> | undefined;
  var __oceankingAgentCompactionQueues: Map<RoomAgentId, Promise<void>> | undefined;
  var __oceankingPendingAutomaticCompactions: Set<RoomAgentId> | undefined;
  var __oceankingAgentRunFinalizationQueues: Map<RoomAgentId, Promise<void>> | undefined;
}

const agentSessions = globalThis.__oceankingAgentRoomSessions ?? new Map<RoomAgentId, AgentRuntimeSession>();
globalThis.__oceankingAgentRoomSessions = agentSessions;
const agentCompactionQueues = globalThis.__oceankingAgentCompactionQueues ?? new Map<RoomAgentId, Promise<void>>();
globalThis.__oceankingAgentCompactionQueues = agentCompactionQueues;
const pendingAutomaticCompactions = globalThis.__oceankingPendingAutomaticCompactions ?? new Set<RoomAgentId>();
globalThis.__oceankingPendingAutomaticCompactions = pendingAutomaticCompactions;
const agentRunFinalizationQueues = globalThis.__oceankingAgentRunFinalizationQueues ?? new Map<RoomAgentId, Promise<void>>();
globalThis.__oceankingAgentRunFinalizationQueues = agentRunFinalizationQueues;

const ROOM_KIND_LABELS: Record<RoomMessageEmission["kind"], string> = {
  answer: "answer",
  progress: "progress",
  warning: "warning",
  error: "error",
  clarification: "clarification",
};

const DEFAULT_STALE_ACTIVE_RUN_TIMEOUT_MS = 150_000;
const ACTIVE_RUN_WAIT_POLL_MS = 25;

function createTimestamp(): string {
  return new Date().toISOString();
}

function getStaleActiveRunTimeoutMs(): number {
  const raw = process.env.OCEANKING_STALE_ACTIVE_RUN_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_ACTIVE_RUN_TIMEOUT_MS;
}

function getContinuationSourceRun(session: AgentRuntimeSession): AgentRuntimeRun | undefined {
  const activeRun = session.activeRun;
  if (!activeRun) {
    return undefined;
  }

  const updatedAtMs = Date.parse(session.updatedAt || "");
  const isStale = Number.isFinite(updatedAtMs) && (Date.now() - updatedAtMs) >= getStaleActiveRunTimeoutMs();
  if (!activeRun.abortController.signal.aborted && !isStale) {
    return activeRun;
  }

  activeRun.abortController.abort(new Error(isStale ? "Cleared stale active room run." : "Cleared aborted active room run."));
  session.activeRun = undefined;
  session.updatedAt = createTimestamp();
  return undefined;
}

function toAbortError(signal: AbortSignal, fallback: string): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  if (typeof signal.reason === "string" && signal.reason.trim()) {
    return new Error(signal.reason);
  }
  return new Error(fallback);
}

async function waitForConflictingActiveRun(args: {
  session: AgentRuntimeSession;
  roomId: string;
  requestSignal: AbortSignal;
}): Promise<void> {
  while (true) {
    const activeRun = getContinuationSourceRun(args.session);
    if (!activeRun || activeRun.roomId === args.roomId) {
      return;
    }

    const workspace = await loadWorkspaceEnvelope().catch(() => null);
    const activeRoom = workspace?.state.rooms.find((room) => room.id === activeRun.roomId);
    if (!activeRoom || activeRoom.scheduler.status !== "running") {
      activeRun.abortController.abort(new Error("Cleared orphaned active room run after workspace stopped tracking it as running."));
      args.session.activeRun = undefined;
      args.session.skipNextLcmAssemble = true;
      args.session.updatedAt = createTimestamp();
      continue;
    }

    if (args.requestSignal.aborted) {
      throw toAbortError(args.requestSignal, "Room run aborted while waiting for another room turn to finish.");
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        args.requestSignal.removeEventListener("abort", handleAbort);
        resolve();
      }, ACTIVE_RUN_WAIT_POLL_MS);

      const handleAbort = () => {
        clearTimeout(timer);
        args.requestSignal.removeEventListener("abort", handleAbort);
        reject(toAbortError(args.requestSignal, "Room run aborted while waiting for another room turn to finish."));
      };

      args.requestSignal.addEventListener("abort", handleAbort, { once: true });
    });
  }
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

function enqueueAgentScopedTask<T>(queue: Map<RoomAgentId, Promise<void>>, agentId: RoomAgentId, task: () => Promise<T>): Promise<T> {
  const previous = queue.get(agentId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(task);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queue.set(agentId, tail);
  return result.finally(() => {
    if (queue.get(agentId) === tail) {
      queue.delete(agentId);
    }
  });
}

function runAgentCompactionTask<T>(agentId: RoomAgentId, task: () => Promise<T>): Promise<T> {
  return enqueueAgentScopedTask(agentCompactionQueues, agentId, task);
}

async function syncCompactedHistoryToIdleSession(agentId: RoomAgentId, history: PersistedVisibleMessage[]): Promise<void> {
  const session = getOrCreateSession(agentId);
  if (session.activeRun) {
    return;
  }
  session.history = history;
  session.updatedAt = createTimestamp();
}

function scheduleAutomaticAgentCompaction(agentId: RoomAgentId): void {
  if (pendingAutomaticCompactions.has(agentId)) {
    return;
  }
  pendingAutomaticCompactions.add(agentId);

  void runAgentCompactionTask(agentId, async () => {
    try {
      const compactResult = await compactPersistedAgentRuntime({
        agentId,
        reason: "post_turn",
      }).catch(() => null);
      if (compactResult?.compacted) {
        await syncCompactedHistoryToIdleSession(agentId, compactResult.history);
      }
    } finally {
      pendingAutomaticCompactions.delete(agentId);
    }
  });
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

async function waitForPendingAutomaticAgentCompaction(agentId: RoomAgentId): Promise<void> {
  if (!pendingAutomaticCompactions.has(agentId)) {
    return;
  }

  await (agentCompactionQueues.get(agentId) ?? Promise.resolve()).catch(() => undefined);
}

function enqueueAgentRunFinalization(agentId: RoomAgentId, task: () => Promise<void>): Promise<void> {
  return enqueueAgentScopedTask(agentRunFinalizationQueues, agentId, task);
}

function hasPendingAgentRunFinalization(agentId: RoomAgentId): boolean {
  return agentRunFinalizationQueues.has(agentId);
}

async function waitForPendingAgentRunFinalization(agentId: RoomAgentId): Promise<void> {
  await (agentRunFinalizationQueues.get(agentId) ?? Promise.resolve()).catch(() => undefined);
}

function lcmMessageToVisibleMessage(content: unknown): PersistedVisibleMessage {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block) => {
            if (!block || typeof block !== "object") {
              return "";
            }
            if (typeof (block as { text?: unknown }).text === "string") {
              return (block as { text: string }).text;
            }
            if (typeof (block as { output?: unknown }).output === "string") {
              return (block as { output: string }).output;
            }
            return JSON.stringify(block);
          })
          .filter(Boolean)
          .join("\n")
      : JSON.stringify(content);
  return {
    id: createUuid(),
    role: "assistant",
    content: text,
    attachments: [],
    createdAt: createTimestamp(),
  };
}

async function assembleSessionViewFromLcm(agentId: RoomAgentId): Promise<{
  history: PersistedVisibleMessage[];
  systemPromptAddition?: string;
} | null> {
  const assembled = await assembleAgentLcmContext(agentId, 20_000);
  if (!assembled) {
    return null;
  }

  return {
    history: assembled.messages.map((message) => ({
      id: createUuid(),
      role: message.role === "user" ? "user" : "assistant",
      content: lcmMessageToVisibleMessage(message.content).content,
      attachments: Array.isArray((message as { attachments?: unknown }).attachments)
        ? ((message as { attachments: MessageImageAttachment[] }).attachments ?? [])
        : [],
      ...((message as { meta?: AssistantMessageMeta }).meta ? { meta: (message as { meta: AssistantMessageMeta }).meta } : {}),
      createdAt: createTimestamp(),
    })),
    systemPromptAddition: assembled.systemPromptAddition,
  };
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trim()}...`;
}

function buildIncomingRoomEnvelope(
  roomId: string,
  roomTitle: string,
  messageId: string,
  sender: RoomSender,
  content: string,
  attachments: MessageImageAttachment[],
): string {
  return [
    "[Incoming Chat Room message]",
    `Room ID: ${roomId}`,
    `Room Title: ${roomTitle}`,
    `Message ID: ${messageId}`,
    `Sender ID: ${sender.id}`,
    `Sender Name: ${sender.name}`,
    `Sender Role: ${sender.role}`,
    attachments.length > 0 ? "Visible room attachments:" : null,
    ...(attachments.length > 0 ? summarizeImageAttachments(attachments) : []),
    "Visible room message:",
    formatMessageForTranscript(content, attachments),
  ].filter((item): item is string => Boolean(item)).join("\n");
}

function buildContinuationSnapshot(run: AgentRuntimeRun): string {
  const sections = [
    "[Continuation snapshot from an unfinished shared agent run]",
      `Current room context: ${run.roomTitle} (${run.roomId})`,
      `Original user message id: ${run.userMessageId}`,
      `Original sender: ${run.userSender.name} (${run.userSender.id}, ${run.userSender.role})`,
      `Original room message:\n${formatMessageForTranscript(run.userContent, run.userAttachments)}`,
      ...(run.userAttachments.length > 0
        ? ["Original room attachments:", ...summarizeImageAttachments(run.userAttachments)]
        : []),
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
    attachments: [...message.attachments],
    ...(message.meta ? { meta: message.meta } : {}),
  }));
}

async function appendContinuationSnapshotToSession(args: {
  agentId: RoomAgentId;
  session: AgentRuntimeSession;
  previousRun: AgentRuntimeRun;
  continuationSnapshot: string;
}): Promise<void> {
  args.session.history.push({
    id: createUuid(),
    role: "assistant",
    content: args.continuationSnapshot,
    attachments: [],
    createdAt: createTimestamp(),
  });
  args.session.updatedAt = createTimestamp();
  await persistSession(args.agentId);
  await ingestContinuationSnapshot({
    agentId: args.agentId,
    requestId: args.previousRun.requestId,
    snapshotText: args.continuationSnapshot,
    roomId: args.previousRun.roomId,
    roomTitle: args.previousRun.roomTitle,
    userMessageId: args.previousRun.userMessageId,
    userSender: args.previousRun.userSender,
    userAttachments: args.previousRun.userAttachments,
    assistantContent: args.previousRun.assistantContent,
    tools: args.previousRun.toolEvents,
    emittedMessages: args.previousRun.emittedMessages,
    roomActions: args.previousRun.roomActions,
    createdAt: createTimestamp(),
  }).catch(() => undefined);
  await clearPostToolCompactionRunState({
    agentId: args.agentId,
    requestId: args.previousRun.requestId,
  }).catch(() => undefined);
}

function createIncomingRoomMessage(args: {
  roomId: string;
  roomTitle: string;
  userMessageId: string;
  userSender: RoomSender;
  userContent: string;
  userAttachments: MessageImageAttachment[];
}): PersistedVisibleMessage {
  return {
    id: createUuid(),
    role: "user",
    content: buildIncomingRoomEnvelope(
      args.roomId,
      args.roomTitle,
      args.userMessageId,
      args.userSender,
      args.userContent,
      args.userAttachments,
    ),
    attachments: [...args.userAttachments],
    createdAt: createTimestamp(),
  };
}

function activateAgentRun(args: {
  session: AgentRuntimeSession;
  requestId: string;
  roomId: string;
  roomTitle: string;
  userMessageId: string;
  userSender: RoomSender;
  userContent: string;
  userAttachments: MessageImageAttachment[];
  abortController: AbortController;
  incomingMessage: PersistedVisibleMessage;
}): void {
  args.session.history.push(args.incomingMessage);
  args.session.activeRun = {
    requestId: args.requestId,
    roomId: args.roomId,
    roomTitle: args.roomTitle,
    userMessageId: args.userMessageId,
    incomingMessageContent: args.incomingMessage.content,
    userSender: args.userSender,
    userContent: args.userContent,
    userAttachments: [...args.userAttachments],
    assistantContent: "",
    toolEvents: [],
    emittedMessages: [],
    roomActions: [],
    abortController: args.abortController,
  };
  args.session.updatedAt = createTimestamp();
}

function removeRunIncomingMessage(session: AgentRuntimeSession, run: AgentRuntimeRun): void {
  const historyIndex = session.history.findLastIndex((message) => (
    message.role === "user" && message.content === run.incomingMessageContent
  ));
  if (historyIndex < 0) {
    return;
  }

  session.history.splice(historyIndex, 1);
}

function createAssistantHistoryMessage(args: {
  run: AgentRuntimeRun;
  assistantText: string;
  meta?: AssistantMessageMeta;
}): PersistedVisibleMessage {
  return {
    id: createUuid(),
    role: "assistant",
    content: buildAssistantHistoryEntry(args.run, args.assistantText),
    attachments: [],
    ...(args.meta ? { meta: args.meta } : {}),
    createdAt: createTimestamp(),
  };
}

function completeRunInSession(args: {
  session: AgentRuntimeSession;
  assistantMessage: PersistedVisibleMessage;
  resolvedModel: string;
  compatibility: ProviderCompatibility;
}): void {
  args.session.history.push(args.assistantMessage);
  args.session.activeRun = undefined;
  args.session.resolvedModel = args.resolvedModel;
  args.session.compatibility = args.compatibility;
  args.session.updatedAt = createTimestamp();
}

async function finalizeCompletedAgentRun(args: {
  agentId: RoomAgentId;
  requestId: string;
  run: AgentRuntimeRun;
  assistantText: string;
  assistantMessage: PersistedVisibleMessage;
  resolvedModel: string;
  compatibility: ProviderCompatibility;
  meta?: AssistantMessageMeta;
  onTimingPhase?: (phase: string, details?: Record<string, unknown>) => void;
}): Promise<void> {
  try {
    args.onTimingPhase?.("complete_run_finalize_runtime_start");
    await finalizePersistedAgentRuntime({
      agentId: args.agentId,
      assistantMessage: args.assistantMessage,
      resolvedModel: args.resolvedModel,
      compatibility: args.compatibility,
      onTimingPhase: args.onTimingPhase,
    });
    args.onTimingPhase?.("complete_run_finalize_runtime_end");

    args.onTimingPhase?.("complete_run_ingest_completed_run_start");
    await ingestCompletedRun({
      agentId: args.agentId,
      requestId: args.requestId,
      assistantText: args.assistantText,
      assistantHistoryEntry: args.assistantMessage.content,
      roomId: args.run.roomId,
      roomTitle: args.run.roomTitle,
      userMessageId: args.run.userMessageId,
      userSender: args.run.userSender,
      userAttachments: args.run.userAttachments,
      emittedMessages: args.run.emittedMessages,
      roomActions: args.run.roomActions,
      tools: args.run.toolEvents,
      resolvedModel: args.resolvedModel,
      compatibility: args.compatibility,
      meta: args.meta,
      createdAt: args.assistantMessage.createdAt,
      onTimingPhase: args.onTimingPhase,
    }).catch((error) => {
      args.onTimingPhase?.("complete_run_ingest_completed_run_error", {
        error: error instanceof Error ? error.message : "Unknown ingest error.",
      });
      return undefined;
    });
    args.onTimingPhase?.("complete_run_ingest_completed_run_end");

    scheduleAutomaticAgentCompaction(args.agentId);
    args.onTimingPhase?.("complete_run_schedule_automatic_compaction");
  } finally {
    await clearPostToolCompactionRunState({
      agentId: args.agentId,
      requestId: args.requestId,
    }).catch(() => undefined);
  }
}

export async function startAgentRoomRun(args: {
  agentId: RoomAgentId;
  roomId: string;
  roomTitle: string;
  attachedRooms: AttachedRoomDescriptor[];
  userMessageId: string;
  userSender: RoomSender;
  userContent: string;
  userAttachments: MessageImageAttachment[];
  requestSignal: AbortSignal;
}) {
  const startupStartedAt = performance.now();
  await waitForPendingAutomaticAgentCompaction(args.agentId);
  const hydrateStartedAt = performance.now();
  const session = await hydrateSession(args.agentId);
  const hydrateMs = performance.now() - hydrateStartedAt;
  await waitForConflictingActiveRun({
    session,
    roomId: args.roomId,
    requestSignal: args.requestSignal,
  });
  const shouldAssembleFromLcm = !hasPendingAgentRunFinalization(args.agentId) && !session.skipNextLcmAssemble;
  const previousRun = getContinuationSourceRun(session);
  const continuationSnapshot = previousRun ? buildContinuationSnapshot(previousRun) : undefined;
  let continuationMs = 0;

  if (previousRun && continuationSnapshot) {
    const continuationStartedAt = performance.now();
    await appendContinuationSnapshotToSession({
      agentId: args.agentId,
      session,
      previousRun,
      continuationSnapshot,
    });
    continuationMs = performance.now() - continuationStartedAt;
  }

  const requestId = createUuid();
  const abortController = new AbortController();
  const mirrorRequestAbort = () => {
    abortController.abort(
      args.requestSignal.reason instanceof Error
        ? args.requestSignal.reason
        : new Error("Room run aborted by the scheduler request signal."),
    );
  };
  if (args.requestSignal.aborted) {
    mirrorRequestAbort();
  } else {
    args.requestSignal.addEventListener("abort", mirrorRequestAbort, { once: true });
  }
  const signal = AbortSignal.any([args.requestSignal, abortController.signal]);

  const incomingMessage = createIncomingRoomMessage({
    roomId: args.roomId,
    roomTitle: args.roomTitle,
    userMessageId: args.userMessageId,
    userSender: args.userSender,
    userContent: args.userContent,
    userAttachments: args.userAttachments,
  });

  activateAgentRun({
    session,
    requestId,
    roomId: args.roomId,
    roomTitle: args.roomTitle,
    userMessageId: args.userMessageId,
    userSender: args.userSender,
    userContent: args.userContent,
    userAttachments: args.userAttachments,
    abortController,
    incomingMessage,
  });
  const persistAndIngestStartedAt = performance.now();
  await persistSession(args.agentId);
  await ingestIncomingRoomEnvelope({
    agentId: args.agentId,
    requestId,
    roomId: args.roomId,
    roomTitle: args.roomTitle,
    userMessageId: args.userMessageId,
    userSender: args.userSender,
    userContent: args.userContent,
    userAttachments: args.userAttachments,
    attachedRooms: args.attachedRooms,
    envelope: incomingMessage.content,
    createdAt: incomingMessage.createdAt,
  }).catch(() => undefined);
  const persistAndIngestMs = performance.now() - persistAndIngestStartedAt;
  const assembleStartedAt = performance.now();
  const assembledPromptContext = shouldAssembleFromLcm
    ? await assembleSessionViewFromLcm(args.agentId).catch(() => null)
    : null;
  const assembleMs = performance.now() - assembleStartedAt;
  if (assembledPromptContext) {
    session.history = assembledPromptContext.history;
  }
  session.skipNextLcmAssemble = false;

  if (previousRun?.roomId === args.roomId) {
    previousRun.abortController.abort(new Error("Superseded by a newer room message."));
  }

  return {
    requestId,
    signal,
    history: toVisibleHistory(session.history),
    compatibility: session.compatibility,
    resolvedModel: session.resolvedModel,
    continuationSnapshot,
    systemPromptAddition: assembledPromptContext?.systemPromptAddition,
    startupTiming: {
      startedAt: startupStartedAt,
      hydrateMs,
      continuationMs,
      persistAndIngestMs,
      assembleMs,
      totalStartupMs: performance.now() - startupStartedAt,
      hadContinuationSnapshot: Boolean(previousRun && continuationSnapshot),
    } satisfies AgentRunStartupTiming,
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
    run.emittedMessages = upsertEmittedRoomMessage(run.emittedMessages, tool.roomMessage);
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
  meta?: AssistantMessageMeta;
  onTimingPhase?: (phase: string, details?: Record<string, unknown>) => void;
}): Promise<void> {
  const hydrateStartedAt = performance.now();
  const session = await hydrateSession(args.agentId);
  args.onTimingPhase?.("complete_run_hydrate_session", {
    durationMs: Math.max(0, performance.now() - hydrateStartedAt),
  });
  const run = session.activeRun;
  if (!run || run.requestId !== args.requestId) {
    return;
  }

  const buildAssistantMessageStartedAt = performance.now();
  const assistantMessage = createAssistantHistoryMessage({
    run,
    assistantText: args.assistantText,
    meta: args.meta,
  });
  args.onTimingPhase?.("complete_run_build_assistant_message", {
    durationMs: Math.max(0, performance.now() - buildAssistantMessageStartedAt),
    assistantChars: assistantMessage.content.length,
    emittedMessageCount: run.emittedMessages.length,
    toolCount: run.toolEvents.length,
  });

  completeRunInSession({
    session,
    assistantMessage,
    resolvedModel: args.resolvedModel,
    compatibility: args.compatibility,
  });
  args.onTimingPhase?.("complete_run_update_in_memory_session", {
    historyCountAfter: session.history.length,
  });
  void enqueueAgentRunFinalization(args.agentId, async () => {
    await finalizeCompletedAgentRun({
      agentId: args.agentId,
      requestId: args.requestId,
      run,
      assistantText: args.assistantText,
      assistantMessage,
      resolvedModel: args.resolvedModel,
      compatibility: args.compatibility,
      meta: args.meta,
      onTimingPhase: args.onTimingPhase,
    });
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
  void clearPostToolCompactionRunState({ agentId, requestId });
}

export async function discardAgentRoomRun(agentId: RoomAgentId, requestId: string): Promise<void> {
  const session = getOrCreateSession(agentId);
  const run = session.activeRun;
  if (!run || run.requestId !== requestId) {
    return;
  }

  removeRunIncomingMessage(session, run);
  session.activeRun = undefined;
  session.skipNextLcmAssemble = true;
  session.updatedAt = createTimestamp();
  await clearPostToolCompactionRunState({ agentId, requestId }).catch(() => undefined);
  await persistSession(agentId).catch(() => undefined);
}

export function clearActiveAgentRoomRunForRoom(agentId: RoomAgentId, roomId: string, reason?: string): void {
  const session = getOrCreateSession(agentId);
  const run = session.activeRun;
  if (!run || run.roomId !== roomId) {
    return;
  }

  run.abortController.abort(new Error(reason ?? "Agent room run cleared."));
  removeRunIncomingMessage(session, run);
  session.activeRun = undefined;
  session.skipNextLcmAssemble = true;
  session.updatedAt = createTimestamp();
  void clearPostToolCompactionRunState({ agentId, requestId: run.requestId });
}

export async function compactAgentRoomSession(agentId: RoomAgentId, reason: "post_turn" | "manual" = "manual") {
  await hydrateSession(agentId);
  const result = await runAgentCompactionTask(agentId, () => compactPersistedAgentRuntime({
    agentId,
    reason,
    force: reason === "manual",
  }));
  if (result.compacted) {
    await syncCompactedHistoryToIdleSession(agentId, result.history);
  }

  return result;
}

export async function resetAgentRoomSession(agentId: RoomAgentId): Promise<void> {
  await waitForPendingAgentRunFinalization(agentId);
  await (agentCompactionQueues.get(agentId) ?? Promise.resolve());
  pendingAutomaticCompactions.delete(agentId);
  const session = getOrCreateSession(agentId);
  session.activeRun?.abortController.abort(new Error("Agent context reset by operator."));
  session.history = [];
  session.activeRun = undefined;
  session.resolvedModel = "";
  session.compatibility = null;
  session.updatedAt = createTimestamp();
  session.loaded = true;
  await clearPostToolCompactionRunState({ agentId }).catch(() => undefined);
  await resetPersistedAgentRuntime(agentId);
}
