"use client";

import { createUuid } from "@/lib/utils/uuid";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ROOM_AGENTS } from "@/lib/chat/catalog";
import type {
  AgentRoomTurn,
  AgentSharedState,
  ChatSettings,
  MemoryBackendId,
  MessageImageAttachment,
  ProviderCompatibility,
  RoomAgentDefinition,
  RoomAgentId,
  RoomMessage,
  RoomMessageEmission,
  RoomMessageReceipt,
  RoomMessageReceiptUpdate,
  RoomParticipant,
  RoomToolActionUnion,
  RoomSchedulerState,
  RoomSender,
  RoomSession,
  RoomWorkspaceState,
  ToolExecution,
} from "@/lib/chat/types";
import {
  coerceCompactionFreshTailCount,
  coerceCompactionTokenThreshold,
  coerceSkillIds,
  coerceThinkingLevel,
  DEFAULT_COMPACTION_FRESH_TAIL_COUNT,
  coerceMaxToolLoopSteps,
  DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  DEFAULT_MAX_TOOL_LOOP_STEPS,
  MAX_MAX_TOOL_LOOP_STEPS,
  MIN_MAX_TOOL_LOOP_STEPS,
} from "@/lib/chat/types";
import {
  applyMessageReceiptUpdate,
  createAgentParticipant,
  createAgentSharedState,
  createHumanParticipant,
  createInitialAgentStates,
  createRoomSession,
  createSchedulerState,
  createTimestamp,
  dedupeRoomMessages,
  getActiveRooms,
  getAgentParticipants,
  getArchivedRooms,
  getEnabledAgentParticipants,
  getHumanParticipants,
  getPrimaryRoomAgentId,
  getReceiptStatus,
  getReceiptUpdatedAt,
  getRoomAgent,
  getRoomPreview,
  pickRoomOwnerParticipantId,
  sortRoomParticipants,
  sortRoomsByUpdatedAt,
} from "@/lib/chat/workspace-domain";
import { applyWorkspaceStatePatch, type WorkspaceStreamEvent } from "@/lib/chat/workspace-stream";
import {
  clearPersistedWorkspaceState,
  fetchWorkspaceEnvelope,
  postRoomCommand,
} from "@/components/workspace/persistence";
import {
  dedupeAgentTurns,
  mergeAgentTurns,
  sortAgentTurnsByUserMessageTime,
} from "@/components/workspace/agent-turn-state";
import { useBrowserWorkspaceCache } from "@/components/workspace/use-browser-workspace-cache";
import { useWorkspaceHydration } from "@/components/workspace/use-workspace-hydration";
import { useWorkspacePersistence } from "@/components/workspace/use-workspace-persistence";
import { useRoomCommands } from "@/components/workspace/use-room-commands";
import { useRoomStreamingSend } from "@/components/workspace/use-room-streaming-send";
import { useWorkspaceStreamSync } from "@/components/workspace/use-workspace-stream-sync";

const DEFAULT_AGENT_ID: RoomAgentId = "concierge";
const DEFAULT_LOCAL_PARTICIPANT_ID = "local-operator";
const LEGACY_DEFAULT_MAX_TOOL_LOOP_STEPS = 6;

const DEFAULT_SETTINGS: ChatSettings = {
  modelConfigId: null,
  apiFormat: "chat_completions",
  model: "",
  systemPrompt: "",
  providerMode: "auto",
  memoryBackend: "sqlite-fts",
  compactionTokenThreshold: DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  compactionFreshTailCount: DEFAULT_COMPACTION_FRESH_TAIL_COUNT,
  maxToolLoopSteps: DEFAULT_MAX_TOOL_LOOP_STEPS,
  thinkingLevel: "off",
  enabledSkillIds: [],
};

const LOCAL_PARTICIPANT_SENDER: RoomSender = {
  id: DEFAULT_LOCAL_PARTICIPANT_ID,
  name: "You",
  role: "participant",
};

const SYSTEM_SENDER: RoomSender = {
  id: "system",
  name: "System",
  role: "system",
};

const GENERIC_AGENT_SENDER: RoomSender = {
  id: "room-agent",
  name: "Room Reply",
  role: "participant",
};

const ROOM_MESSAGE_KINDS = [
  "user_input",
  "answer",
  "progress",
  "warning",
  "error",
  "clarification",
  "system",
] as const;

const ROOM_VISIBLE_MESSAGE_KINDS = ["answer", "progress", "warning", "error", "clarification"] as const;
const ROOM_MESSAGE_STATUSES = ["pending", "streaming", "completed", "failed"] as const;
const AGENT_TURN_STATUSES = ["running", "continued", "completed", "error"] as const;

interface AgentMutationInput {
  id: string;
  label: string;
  summary: string;
  skills?: string[];
  workingStyle: string;
  instruction: string;
}

interface AgentUpdateInput {
  label?: string;
  summary?: string;
  skills?: string[];
  workingStyle?: string;
  instruction?: string;
}

function createInitialAgentCompactionFeedback(agentDefinitions: RoomAgentDefinition[] = ROOM_AGENTS): Record<RoomAgentId, AgentCompactionFeedback | null> {
  const definitions = agentDefinitions.length > 0 ? agentDefinitions : [getRoomAgent(DEFAULT_AGENT_ID)];
  return Object.fromEntries(definitions.map((agent) => [agent.id, null])) as Record<RoomAgentId, AgentCompactionFeedback | null>;
}

interface SendMessageArgs {
  roomId: string;
  content: string;
  attachments?: MessageImageAttachment[];
  senderId?: string;
}

export interface AgentCompactionFeedback {
  status: "success" | "noop" | "error";
  message: string;
  summary: string;
  updatedAt: string;
}

interface WorkspaceContextValue {
  hydrated: boolean;
  agents: RoomAgentDefinition[];
  rooms: RoomSession[];
  activeRooms: RoomSession[];
  archivedRooms: RoomSession[];
  activeRoomId: string;
  activeRoom: RoomSession | null;
  agentStates: Record<RoomAgentId, AgentSharedState>;
  agentCompactionFeedback: Record<RoomAgentId, AgentCompactionFeedback | null>;
  runningAgentRequestIds: Record<string, string>;
  selectedConsoleAgentId: RoomAgentId | null;
  selectedSenderByRoomId: Record<string, string>;
  draftsByRoomId: Record<string, string>;
  setActiveRoomId: (roomId: string) => void;
  setSelectedConsoleAgentId: (agentId: RoomAgentId) => void;
  setSelectedSender: (roomId: string, participantId: string) => void;
  setDraft: (roomId: string, value: string) => void;
  getAgentDefinition: (agentId: RoomAgentId) => RoomAgentDefinition;
  getRoomById: (roomId: string) => RoomSession | null;
  isAgentRunning: (agentId: RoomAgentId) => boolean;
  isAgentCompacting: (agentId: RoomAgentId) => boolean;
  isRoomRunning: (roomId: string) => boolean;
  createRoom: (agentId?: RoomAgentId) => Promise<RoomSession | null>;
  createAgentDefinition: (input: AgentMutationInput) => Promise<RoomAgentDefinition>;
  renameRoom: (roomId: string, title: string) => Promise<void>;
  archiveRoom: (roomId: string) => Promise<void>;
  restoreRoom: (roomId: string) => Promise<void>;
  deleteRoom: (roomId: string) => Promise<void>;
  clearRoom: (roomId: string) => Promise<void>;
  clearRoomLogs: (roomId: string) => Promise<void>;
  addHumanParticipant: (roomId: string, name: string) => Promise<void>;
  addAgentParticipant: (roomId: string, agentId: RoomAgentId) => Promise<void>;
  removeParticipant: (roomId: string, participantId: string) => Promise<void>;
  toggleAgentParticipant: (roomId: string, participantId: string) => Promise<void>;
  moveAgentParticipant: (roomId: string, participantId: string, direction: -1 | 1) => Promise<void>;
  stopRoom: (roomId: string) => Promise<void>;
  sendMessage: (args: SendMessageArgs) => Promise<void>;
  clearAllWorkspace: () => Promise<void>;
  clearAgentConsole: (agentId: RoomAgentId) => void;
  resetAgentContext: (agentId: RoomAgentId) => Promise<void>;
  compactAgentContext: (agentId: RoomAgentId) => Promise<void>;
  updateAgentSettings: (agentId: RoomAgentId, patch: Partial<ChatSettings>) => void;
  updateAgentDefinition: (agentId: RoomAgentId, patch: AgentUpdateInput) => Promise<RoomAgentDefinition>;
}

type WorkspaceRoomsContextValue = Pick<
  WorkspaceContextValue,
  "hydrated" | "rooms" | "activeRooms" | "archivedRooms" | "activeRoomId" | "activeRoom" | "selectedSenderByRoomId" | "draftsByRoomId"
>;

type WorkspaceAgentsContextValue = Pick<
  WorkspaceContextValue,
  "agents" | "agentStates" | "agentCompactionFeedback" | "runningAgentRequestIds" | "selectedConsoleAgentId"
>;

type WorkspaceActionsContextValue = Omit<
  WorkspaceContextValue,
  keyof WorkspaceRoomsContextValue | keyof WorkspaceAgentsContextValue
>;

const WorkspaceRoomsContext = createContext<WorkspaceRoomsContextValue | null>(null);
const WorkspaceAgentsContext = createContext<WorkspaceAgentsContextValue | null>(null);
const WorkspaceActionsContext = createContext<WorkspaceActionsContextValue | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRoomMessageKind(value: unknown): value is RoomMessage["kind"] {
  return typeof value === "string" && ROOM_MESSAGE_KINDS.includes(value as RoomMessage["kind"]);
}

function isVisibleRoomMessageKind(value: unknown): value is RoomMessageEmission["kind"] {
  return typeof value === "string" && ROOM_VISIBLE_MESSAGE_KINDS.includes(value as RoomMessageEmission["kind"]);
}

function isRoomMessageStatus(value: unknown): value is RoomMessage["status"] {
  return typeof value === "string" && ROOM_MESSAGE_STATUSES.includes(value as RoomMessage["status"]);
}

function isAgentTurnStatus(value: unknown): value is AgentRoomTurn["status"] {
  return typeof value === "string" && AGENT_TURN_STATUSES.includes(value as AgentRoomTurn["status"]);
}

function isRoomAgentId(value: unknown): value is RoomAgentId {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeRoomAgentId(value: unknown): RoomAgentId {
  return isRoomAgentId(value) ? value.trim().slice(0, 120) : DEFAULT_AGENT_ID;
}

function normalizeRoomAgentIds(value: unknown): RoomAgentId[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter(isRoomAgentId).map((agentId) => agentId.trim()).filter(Boolean))];
}

function ensureAgentStateMap(
  current: Record<RoomAgentId, AgentSharedState>,
  agentDefinitions: RoomAgentDefinition[],
  rooms: RoomSession[],
): Record<RoomAgentId, AgentSharedState> {
  const nextState = { ...current };
  for (const agent of agentDefinitions) {
    nextState[agent.id] = nextState[agent.id] ?? createAgentSharedState();
  }
  for (const room of rooms) {
    for (const participant of room.participants) {
      if (participant.runtimeKind === "agent" && participant.agentId) {
        nextState[participant.agentId] = nextState[participant.agentId] ?? createAgentSharedState();
      }
    }
  }
  return nextState;
}

function ensureAgentFeedbackMap(
  current: Record<RoomAgentId, AgentCompactionFeedback | null>,
  agentDefinitions: RoomAgentDefinition[],
  agentStates: Record<RoomAgentId, AgentSharedState>,
): Record<RoomAgentId, AgentCompactionFeedback | null> {
  const nextState = { ...current };
  for (const agent of agentDefinitions) {
    nextState[agent.id] = nextState[agent.id] ?? null;
  }
  for (const agentId of Object.keys(agentStates)) {
    nextState[agentId] = nextState[agentId] ?? null;
  }
  return nextState;
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

async function fetchAgentDefinitions(): Promise<RoomAgentDefinition[]> {
  const response = await fetch("/api/agents", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to load agents.");
  }

  const payload = await parseJsonResponse<{ agents?: RoomAgentDefinition[] }>(response);
  return payload?.agents ?? [];
}

async function createAgentDefinitionRequest(input: AgentMutationInput): Promise<RoomAgentDefinition> {
  const response = await fetch("/api/agents", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = await parseJsonResponse<{ agent?: RoomAgentDefinition; error?: string }>(response);
  if (!response.ok || !payload?.agent) {
    throw new Error(payload?.error || "Failed to create agent.");
  }

  return payload.agent;
}

async function updateAgentDefinitionRequest(agentId: RoomAgentId, patch: AgentUpdateInput): Promise<RoomAgentDefinition> {
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  const payload = await parseJsonResponse<{ agent?: RoomAgentDefinition; error?: string }>(response);
  if (!response.ok || !payload?.agent) {
    throw new Error(payload?.error || "Failed to update agent.");
  }

  return payload.agent;
}

function getRoomIndexTitle(index: number): string {
  return `Room ${index}`;
}

function getSuggestedRoomTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.length > 30 ? `${normalized.slice(0, 30).trim()}...` : normalized;
}

function formatReceiptSummary(receipts: RoomMessageReceipt[]): string {
  return [...receipts]
    .sort((left, right) => {
      const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
      if (byCreatedAt !== 0) {
        return byCreatedAt;
      }

      return left.participantName.localeCompare(right.participantName);
    })
    .map((receipt) => `✓ ${receipt.participantName}`)
    .join(", ");
}

function getReceiptInlineNote(receipts: RoomMessageReceipt[]): string {
  const summary = formatReceiptSummary(receipts);
  return summary ? `${summary} read this and chose not to send a visible message.` : "";
}

function createLegacyReceipt(updatedAt: string, participantName = "AI"): RoomMessageReceipt {
  return {
    participantId: `legacy-read-no-reply-${participantName.toLowerCase().replace(/\s+/g, "-")}`,
    participantName,
    type: "read_no_reply",
    createdAt: updatedAt,
  };
}

function sortRoomMessageReceipts(receipts: RoomMessageReceipt[]): RoomMessageReceipt[] {
  return [...receipts].sort((left, right) => {
    const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }

    return left.participantName.localeCompare(right.participantName);
  });
}

function createParticipantId(prefix: string): string {
  return `${prefix}-${createUuid()}`;
}

function getLegacyRoomSender(role: RoomMessage["role"], source: RoomMessage["source"]): RoomSender {
  if (role === "system" || source === "system") {
    return SYSTEM_SENDER;
  }

  if (role === "assistant" || source === "agent_emit") {
    return GENERIC_AGENT_SENDER;
  }

  return LOCAL_PARTICIPANT_SENDER;
}

function normalizeRoomSender(value: unknown, role: RoomMessage["role"], source: RoomMessage["source"]): RoomSender {
  if (!isRecord(value)) {
    return getLegacyRoomSender(role, source);
  }

  const fallback = getLegacyRoomSender(role, source);
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : fallback.id;
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : fallback.name;

  return {
    id,
    name,
    role: value.role === "participant" || value.role === "system" ? value.role : fallback.role,
  };
}

function normalizeRoomMessageReceipt(value: unknown): RoomMessageReceipt | null {
  if (!isRecord(value)) {
    return null;
  }

  const participantId = typeof value.participantId === "string" && value.participantId.trim() ? value.participantId.trim() : "";
  const participantName =
    typeof value.participantName === "string" && value.participantName.trim() ? value.participantName.trim() : "AI";
  const createdAt = typeof value.createdAt === "string" && value.createdAt ? value.createdAt : createTimestamp();
  if (!participantId) {
    return null;
  }

  return {
    participantId,
    participantName,
    ...(isRoomAgentId(value.agentId)
      ? {
          agentId: value.agentId.trim(),
        }
      : {}),
    type: "read_no_reply",
    createdAt,
  };
}

function normalizeRoomMessageReceipts(
  value: unknown,
  legacyStatus: unknown,
  legacyUpdatedAt: unknown,
  fallbackCreatedAt: string,
): RoomMessageReceipt[] {
  const receipts = Array.isArray(value)
    ? value
        .map((receipt) => normalizeRoomMessageReceipt(receipt))
        .filter((receipt): receipt is RoomMessageReceipt => Boolean(receipt))
    : [];

  if (receipts.length > 0) {
    return sortRoomMessageReceipts(receipts);
  }

  if (legacyStatus === "read_no_reply") {
    return [createLegacyReceipt(typeof legacyUpdatedAt === "string" && legacyUpdatedAt ? legacyUpdatedAt : fallbackCreatedAt)];
  }

  return [];
}

function normalizeRoomMessageEmission(value: unknown): RoomMessageEmission | undefined {
  if (typeof value === "string") {
    const content = value.trim();
    return content
      ? {
          roomId: "",
          content,
          kind: "answer",
          status: "completed",
          final: true,
        }
      : undefined;
  }

  if (!isRecord(value) || typeof value.content !== "string") {
    return undefined;
  }

  const content = value.content.trim();
  if (!content) {
    return undefined;
  }

  return {
    roomId: typeof value.roomId === "string" ? value.roomId : "",
    content,
    kind: isVisibleRoomMessageKind(value.kind) ? value.kind : "answer",
    status: isRoomMessageStatus(value.status) ? value.status : "completed",
    final: typeof value.final === "boolean" ? value.final : true,
  };
}

function normalizeRoomToolAction(value: unknown): RoomToolActionUnion | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  if (value.type === "read_no_reply") {
    return {
      type: "read_no_reply",
      roomId: typeof value.roomId === "string" ? value.roomId : "",
      messageId: typeof value.messageId === "string" ? value.messageId : "",
    };
  }

  if (value.type === "create_room") {
    return {
      type: "create_room",
      roomId: typeof value.roomId === "string" ? value.roomId : createUuid(),
      title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : "New Room",
      agentIds: normalizeRoomAgentIds(value.agentIds),
    };
  }

  if (value.type === "add_agents_to_room") {
    return {
      type: "add_agents_to_room",
      roomId: typeof value.roomId === "string" ? value.roomId : "",
      agentIds: normalizeRoomAgentIds(value.agentIds),
    };
  }

  if (value.type === "leave_room") {
    return {
      type: "leave_room",
      roomId: typeof value.roomId === "string" ? value.roomId : "",
    };
  }

  if (value.type === "remove_room_participant") {
    return {
      type: "remove_room_participant",
      roomId: typeof value.roomId === "string" ? value.roomId : "",
      participantId: typeof value.participantId === "string" ? value.participantId : "",
    };
  }

  return undefined;
}

function normalizeMessageImageAttachment(value: unknown): MessageImageAttachment | null {
  if (!isRecord(value) || value.kind !== "image") {
    return null;
  }

  return {
    id: typeof value.id === "string" && value.id ? value.id : createUuid(),
    kind: "image",
    mimeType: typeof value.mimeType === "string" ? value.mimeType : "image/png",
    filename: typeof value.filename === "string" && value.filename ? value.filename : "image",
    sizeBytes: typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes) ? Math.max(0, Math.round(value.sizeBytes)) : 0,
    storagePath: typeof value.storagePath === "string" ? value.storagePath : "",
    url: typeof value.url === "string" ? value.url : "",
  };
}

function normalizeRoomMessage(
  value: unknown,
  fallbackRole: RoomMessage["role"] = "assistant",
  fallbackSource: RoomMessage["source"] = "agent_emit",
): RoomMessage | null {
  if (!isRecord(value) || typeof value.content !== "string") {
    return null;
  }

  const content = value.content.trim();
  const attachments = Array.isArray(value.attachments)
    ? value.attachments
        .map((attachment) => normalizeMessageImageAttachment(attachment))
        .filter((attachment): attachment is MessageImageAttachment => Boolean(attachment))
    : [];
  if (!content && attachments.length === 0) {
    return null;
  }

  const role = value.role === "user" || value.role === "assistant" || value.role === "system" ? value.role : fallbackRole;
  const source =
    value.source === "user" || value.source === "agent_emit" || value.source === "system" ? value.source : fallbackSource;
  const defaultKind = role === "user" ? "user_input" : role === "system" ? "system" : "answer";
  const normalizedKind = isRoomMessageKind(value.kind) ? value.kind : defaultKind;
  const createdAt = typeof value.createdAt === "string" && value.createdAt ? value.createdAt : createTimestamp();
  const receipts = normalizeRoomMessageReceipts(value.receipts, value.receiptStatus, value.receiptUpdatedAt, createdAt);

  return {
    id: typeof value.id === "string" && value.id ? value.id : createUuid(),
    roomId: typeof value.roomId === "string" && value.roomId ? value.roomId : "",
    seq: typeof value.seq === "number" && Number.isFinite(value.seq) && value.seq > 0 ? Math.round(value.seq) : 0,
    role,
    sender: normalizeRoomSender(value.sender, role, source),
    content,
    attachments,
    source,
    kind: normalizedKind,
    status: isRoomMessageStatus(value.status) ? value.status : "completed",
    final: typeof value.final === "boolean" ? value.final : normalizedKind !== "progress",
    createdAt,
    receipts,
    receiptStatus: getReceiptStatus(receipts),
    receiptUpdatedAt: getReceiptUpdatedAt(receipts),
  };
}

function normalizeRoomParticipant(value: unknown, fallbackOrder: number): RoomParticipant | null {
  if (!isRecord(value)) {
    return null;
  }

  const runtimeKind = value.runtimeKind === "agent" ? "agent" : value.runtimeKind === "human" ? "human" : null;
  if (!runtimeKind) {
    return null;
  }

  const timestamp = createTimestamp();
  const agentId = runtimeKind === "agent" ? normalizeRoomAgentId(value.agentId) : undefined;

  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : runtimeKind === "agent" && agentId ? agentId : createParticipantId(runtimeKind),
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : runtimeKind === "agent" && agentId
          ? getRoomAgent(agentId).label
          : "Participant",
    senderRole: value.senderRole === "system" ? "system" : "participant",
    runtimeKind,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    order: typeof value.order === "number" && Number.isFinite(value.order) ? Math.max(0, Math.round(value.order)) : fallbackOrder,
    ...(agentId ? { agentId } : {}),
    createdAt: typeof value.createdAt === "string" && value.createdAt ? value.createdAt : timestamp,
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt ? value.updatedAt : timestamp,
  };
}

function normalizeRoomParticipants(value: unknown, legacyAgentId: RoomAgentId): RoomParticipant[] {
  const normalized = Array.isArray(value)
    ? value
        .map((participant, index) => normalizeRoomParticipant(participant, index + 1))
        .filter((participant): participant is RoomParticipant => Boolean(participant))
    : [];

  const participants = normalized.length > 0 ? normalized : [createHumanParticipant(LOCAL_PARTICIPANT_SENDER.name), createAgentParticipant(legacyAgentId, 1)];
  const hasLocalHuman = participants.some((participant) => participant.runtimeKind === "human" && participant.id === DEFAULT_LOCAL_PARTICIPANT_ID);
  const withRequiredHuman = hasLocalHuman ? participants : [createHumanParticipant(LOCAL_PARTICIPANT_SENDER.name), ...participants];
  const uniqueParticipants = withRequiredHuman.filter(
    (participant, index, list) => list.findIndex((candidate) => candidate.id === participant.id) === index,
  );
  return sortRoomParticipants(uniqueParticipants);
}

function normalizeScheduler(value: unknown, participants: RoomParticipant[]): RoomSchedulerState {
  const enabledAgents = participants.filter((participant) => participant.runtimeKind === "agent" && participant.enabled);
  const fallbackNextAgentId = enabledAgents[0]?.id ?? null;

  if (!isRecord(value)) {
    return createSchedulerState(fallbackNextAgentId);
  }

  const rawCursor = isRecord(value.agentCursorByParticipantId) ? value.agentCursorByParticipantId : {};
  const agentCursorByParticipantId = Object.fromEntries(
    Object.entries(rawCursor)
      .filter((entry): entry is [string, unknown] => typeof entry[0] === "string")
      .map(([participantId, cursorValue]) => [participantId, typeof cursorValue === "number" && Number.isFinite(cursorValue) ? Math.max(0, Math.round(cursorValue)) : 0]),
  ) as Record<string, number>;
  const rawReceiptRevision = isRecord(value.agentReceiptRevisionByParticipantId) ? value.agentReceiptRevisionByParticipantId : {};
  const agentReceiptRevisionByParticipantId = Object.fromEntries(
    Object.entries(rawReceiptRevision)
      .filter((entry): entry is [string, unknown] => typeof entry[0] === "string")
      .map(([participantId, revisionValue]) => [participantId, typeof revisionValue === "number" && Number.isFinite(revisionValue) ? Math.max(0, Math.round(revisionValue)) : 0]),
  ) as Record<string, number>;

  return {
    status: value.status === "running" ? "running" : "idle",
    nextAgentParticipantId:
      typeof value.nextAgentParticipantId === "string" && enabledAgents.some((participant) => participant.id === value.nextAgentParticipantId)
        ? value.nextAgentParticipantId
        : fallbackNextAgentId,
    activeParticipantId:
      typeof value.activeParticipantId === "string" && participants.some((participant) => participant.id === value.activeParticipantId)
        ? value.activeParticipantId
        : null,
    roundCount: typeof value.roundCount === "number" && Number.isFinite(value.roundCount) ? Math.max(0, Math.round(value.roundCount)) : 0,
    agentCursorByParticipantId,
    agentReceiptRevisionByParticipantId,
  };
}

function normalizeToolExecution(value: unknown, index: number): ToolExecution | null {
  if (!isRecord(value)) {
    return null;
  }

  const inputText = typeof value.inputText === "string" ? value.inputText : "";
  const outputText = typeof value.outputText === "string" ? value.outputText : "";
  const normalizedDetails = normalizeToolExecutionDetails(value.details);

  return {
    id: typeof value.id === "string" && value.id ? value.id : createUuid(),
    sequence: typeof value.sequence === "number" && value.sequence > 0 ? value.sequence : index + 1,
    toolName: typeof value.toolName === "string" && value.toolName ? value.toolName : "tool",
    displayName: typeof value.displayName === "string" && value.displayName ? value.displayName : "Tool",
    inputSummary: typeof value.inputSummary === "string" ? value.inputSummary : inputText,
    inputText,
    resultPreview: typeof value.resultPreview === "string" ? value.resultPreview : outputText,
    outputText,
    status: value.status === "error" ? "error" : "success",
    durationMs: typeof value.durationMs === "number" && value.durationMs >= 0 ? value.durationMs : 0,
    ...(normalizedDetails ? { details: normalizedDetails } : {}),
    ...(normalizeRoomMessageEmission(value.roomMessage)
      ? {
          roomMessage: normalizeRoomMessageEmission(value.roomMessage),
        }
      : {}),
    ...(normalizeRoomToolAction(value.roomAction)
      ? {
          roomAction: normalizeRoomToolAction(value.roomAction),
        }
      : {}),
  };
}

function normalizeToolExecutionDetails(value: unknown): ToolExecution["details"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const details: NonNullable<ToolExecution["details"]> = {};

  if (typeof value.exitCode === "number" && Number.isFinite(value.exitCode)) {
    details.exitCode = Math.round(value.exitCode);
  } else if (value.exitCode === null) {
    details.exitCode = null;
  }

  if (typeof value.truncated === "boolean") {
    details.truncated = value.truncated;
  }

  if (typeof value.fullOutputPath === "string") {
    details.fullOutputPath = value.fullOutputPath;
  }

  if (typeof value.cwd === "string") {
    details.cwd = value.cwd;
  }

  if (typeof value.shell === "string") {
    details.shell = value.shell;
  }

  if (typeof value.timedOut === "boolean") {
    details.timedOut = value.timedOut;
  }

  if (typeof value.aborted === "boolean") {
    details.aborted = value.aborted;
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function normalizeTurnTimelineEvent(value: unknown, index: number): NonNullable<AgentRoomTurn["timeline"]>[number] | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  const id = typeof value.id === "string" && value.id ? value.id : createUuid();
  const sequence = typeof value.sequence === "number" && Number.isFinite(value.sequence) ? Math.max(1, Math.round(value.sequence)) : index + 1;

  if (value.type === "tool" && typeof value.toolId === "string" && value.toolId) {
    return {
      id,
      sequence,
      type: "tool",
      toolId: value.toolId,
    };
  }

  if (value.type === "room-message" && typeof value.messageId === "string" && value.messageId && typeof value.roomId === "string" && value.roomId) {
    return {
      id,
      sequence,
      type: "room-message",
      messageId: value.messageId,
      roomId: value.roomId,
    };
  }

  if (value.type === "draft-segment" && typeof value.segmentId === "string" && value.segmentId) {
    return {
      id,
      sequence,
      type: "draft-segment",
      segmentId: value.segmentId,
    };
  }

  return null;
}

function normalizeDraftTextSegment(value: unknown, index: number): NonNullable<AgentRoomTurn["draftSegments"]>[number] | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" && value.id ? value.id : createUuid();
  const sequence = typeof value.sequence === "number" && Number.isFinite(value.sequence) ? Math.max(1, Math.round(value.sequence)) : index + 1;
  const content = typeof value.content === "string" ? value.content : "";
  const status = value.status === "streaming" ? "streaming" : "completed";

  return {
    id,
    sequence,
    content,
    status,
  };
}

function normalizeCompatibility(value: unknown): ProviderCompatibility | null {
  if (!isRecord(value) || typeof value.providerLabel !== "string" || typeof value.baseUrl !== "string") {
    return null;
  }

  if (value.providerKey !== "openai" && value.providerKey !== "right_codes" && value.providerKey !== "generic") {
    return null;
  }

  return {
    providerKey: value.providerKey,
    providerLabel: value.providerLabel,
    baseUrl: value.baseUrl,
    chatCompletionsToolStyle: value.chatCompletionsToolStyle === "functions" ? "functions" : "tools",
    responsesContinuation: value.responsesContinuation === "previous_response_id" ? "previous_response_id" : "replay",
    responsesPayloadMode:
      value.responsesPayloadMode === "sse" ? "sse" : value.responsesPayloadMode === "auto" ? "auto" : "json",
    notes: Array.isArray(value.notes) ? value.notes.filter((note): note is string => typeof note === "string") : [],
  };
}

function normalizeAssistantUsage(value: unknown): NonNullable<AgentRoomTurn["meta"]>["usage"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const input = typeof value.input === "number" && Number.isFinite(value.input) ? value.input : null;
  const output = typeof value.output === "number" && Number.isFinite(value.output) ? value.output : null;
  const cacheRead = typeof value.cacheRead === "number" && Number.isFinite(value.cacheRead) ? value.cacheRead : null;
  const cacheWrite = typeof value.cacheWrite === "number" && Number.isFinite(value.cacheWrite) ? value.cacheWrite : null;
  const totalTokens = typeof value.totalTokens === "number" && Number.isFinite(value.totalTokens) ? value.totalTokens : null;

  if (input === null || output === null || cacheRead === null || cacheWrite === null || totalTokens === null) {
    return undefined;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
  };
}

function normalizeAssistantContinuation(value: unknown): NonNullable<AgentRoomTurn["meta"]>["continuation"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.strategy !== "previous_response_id" && value.strategy !== "replay") {
    return undefined;
  }

  return {
    strategy: value.strategy,
    ...(typeof value.previousResponseId === "string" && value.previousResponseId
      ? {
          previousResponseId: value.previousResponseId,
        }
      : {}),
  };
}

function normalizeAssistantHistoryTextPart(value: unknown) {
  if (!isRecord(value) || value.type !== "text" || typeof value.text !== "string") {
    return undefined;
  }

  return {
    type: "text" as const,
    text: value.text,
    ...(typeof value.textSignature === "string" && value.textSignature
      ? {
          textSignature: value.textSignature,
        }
      : {}),
  };
}

function normalizeAssistantHistoryImagePart(value: unknown) {
  if (!isRecord(value) || value.type !== "image" || typeof value.data !== "string" || typeof value.mimeType !== "string") {
    return undefined;
  }

  return {
    type: "image" as const,
    data: value.data,
    mimeType: value.mimeType,
  };
}

function normalizeAssistantHistoryThinkingPart(value: unknown) {
  if (!isRecord(value) || value.type !== "thinking" || typeof value.thinking !== "string") {
    return undefined;
  }

  return {
    type: "thinking" as const,
    thinking: value.thinking,
    ...(typeof value.thinkingSignature === "string" && value.thinkingSignature
      ? {
          thinkingSignature: value.thinkingSignature,
        }
      : {}),
    ...(typeof value.redacted === "boolean"
      ? {
          redacted: value.redacted,
        }
      : {}),
  };
}

function normalizeAssistantHistoryToolCallPart(value: unknown) {
  if (!isRecord(value) || value.type !== "toolCall" || typeof value.id !== "string" || typeof value.name !== "string") {
    return undefined;
  }

  return {
    type: "toolCall" as const,
    id: value.id,
    name: value.name,
    arguments: isRecord(value.arguments) ? value.arguments : {},
    ...(typeof value.partialJson === "string" && value.partialJson
      ? {
          partialJson: value.partialJson,
        }
      : {}),
    ...(typeof value.thoughtSignature === "string" && value.thoughtSignature
      ? {
          thoughtSignature: value.thoughtSignature,
        }
      : {}),
  };
}

function normalizeAssistantHistoryUsage(value: unknown) {
  if (!isRecord(value) || !isRecord(value.cost)) {
    return undefined;
  }

  return {
    input: typeof value.input === "number" && Number.isFinite(value.input) ? value.input : 0,
    output: typeof value.output === "number" && Number.isFinite(value.output) ? value.output : 0,
    cacheRead: typeof value.cacheRead === "number" && Number.isFinite(value.cacheRead) ? value.cacheRead : 0,
    cacheWrite: typeof value.cacheWrite === "number" && Number.isFinite(value.cacheWrite) ? value.cacheWrite : 0,
    totalTokens: typeof value.totalTokens === "number" && Number.isFinite(value.totalTokens) ? value.totalTokens : 0,
    cost: {
      input: typeof value.cost.input === "number" && Number.isFinite(value.cost.input) ? value.cost.input : 0,
      output: typeof value.cost.output === "number" && Number.isFinite(value.cost.output) ? value.cost.output : 0,
      cacheRead: typeof value.cost.cacheRead === "number" && Number.isFinite(value.cost.cacheRead) ? value.cost.cacheRead : 0,
      cacheWrite: typeof value.cost.cacheWrite === "number" && Number.isFinite(value.cost.cacheWrite) ? value.cost.cacheWrite : 0,
      total: typeof value.cost.total === "number" && Number.isFinite(value.cost.total) ? value.cost.total : 0,
    },
  };
}

function normalizeAssistantHistoryMessage(value: unknown): NonNullable<NonNullable<AgentRoomTurn["meta"]>["historyDelta"]>[number] | undefined {
  if (!isRecord(value) || typeof value.role !== "string") {
    return undefined;
  }

  if (value.role === "user") {
    let content: string | Array<
      NonNullable<ReturnType<typeof normalizeAssistantHistoryTextPart>>
      | NonNullable<ReturnType<typeof normalizeAssistantHistoryImagePart>>
    > | null = null;

    if (typeof value.content === "string") {
      content = value.content;
    } else if (Array.isArray(value.content)) {
      const normalizedContent: Array<
        NonNullable<ReturnType<typeof normalizeAssistantHistoryTextPart>>
        | NonNullable<ReturnType<typeof normalizeAssistantHistoryImagePart>>
      > = [];
      for (const item of value.content) {
        const text = normalizeAssistantHistoryTextPart(item);
        if (text) {
          normalizedContent.push(text);
          continue;
        }

        const image = normalizeAssistantHistoryImagePart(item);
        if (image) {
          normalizedContent.push(image);
        }
      }
      content = normalizedContent;
    }

    if (content === null) {
      return undefined;
    }

    return {
      role: "user",
      content,
      timestamp: typeof value.timestamp === "number" && Number.isFinite(value.timestamp) ? value.timestamp : Date.now(),
    };
  }

  if (value.role === "assistant") {
    const usage = normalizeAssistantHistoryUsage(value.usage);
    if (!Array.isArray(value.content) || !usage || typeof value.api !== "string" || typeof value.provider !== "string" || typeof value.model !== "string") {
      return undefined;
    }

    const content: Array<
      NonNullable<ReturnType<typeof normalizeAssistantHistoryTextPart>>
      | NonNullable<ReturnType<typeof normalizeAssistantHistoryThinkingPart>>
      | NonNullable<ReturnType<typeof normalizeAssistantHistoryToolCallPart>>
    > = [];
    for (const item of value.content) {
      const text = normalizeAssistantHistoryTextPart(item);
      if (text) {
        content.push(text);
        continue;
      }

      const thinking = normalizeAssistantHistoryThinkingPart(item);
      if (thinking) {
        content.push(thinking);
        continue;
      }

      const toolCall = normalizeAssistantHistoryToolCallPart(item);
      if (toolCall) {
        content.push(toolCall);
      }
    }

    if (value.stopReason !== "stop" && value.stopReason !== "length" && value.stopReason !== "toolUse" && value.stopReason !== "error" && value.stopReason !== "aborted") {
      return undefined;
    }

    return {
      role: "assistant",
      content,
      api: value.api,
      provider: value.provider,
      model: value.model,
      usage,
      stopReason: value.stopReason,
      timestamp: typeof value.timestamp === "number" && Number.isFinite(value.timestamp) ? value.timestamp : Date.now(),
      ...(typeof value.responseId === "string" && value.responseId
        ? {
            responseId: value.responseId,
          }
        : {}),
      ...(typeof value.errorMessage === "string" && value.errorMessage
        ? {
            errorMessage: value.errorMessage,
          }
        : {}),
    };
  }

  if (value.role === "toolResult") {
    if (!Array.isArray(value.content) || typeof value.toolCallId !== "string" || typeof value.toolName !== "string") {
      return undefined;
    }

    const content: Array<
      NonNullable<ReturnType<typeof normalizeAssistantHistoryTextPart>>
      | NonNullable<ReturnType<typeof normalizeAssistantHistoryImagePart>>
    > = [];
    for (const item of value.content) {
      const text = normalizeAssistantHistoryTextPart(item);
      if (text) {
        content.push(text);
        continue;
      }

      const image = normalizeAssistantHistoryImagePart(item);
      if (image) {
        content.push(image);
      }
    }

    return {
      role: "toolResult",
      toolCallId: value.toolCallId,
      toolName: value.toolName,
      content,
      isError: typeof value.isError === "boolean" ? value.isError : false,
      timestamp: typeof value.timestamp === "number" && Number.isFinite(value.timestamp) ? value.timestamp : Date.now(),
      ...("details" in value ? { details: value.details } : {}),
    };
  }

  return undefined;
}

function normalizeAssistantHistoryDelta(value: unknown): NonNullable<AgentRoomTurn["meta"]>["historyDelta"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.flatMap((item) => {
    const message = normalizeAssistantHistoryMessage(item);
    return message ? [message] : [];
  });

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAssistantMeta(value: unknown): AgentRoomTurn["meta"] | undefined {
  if (!isRecord(value) || !isRecord(value.compatibility)) {
    return undefined;
  }

  if (value.apiFormat !== "chat_completions" && value.apiFormat !== "responses") {
    return undefined;
  }

  const compatibility = normalizeCompatibility(value.compatibility);
  if (!compatibility) {
    return undefined;
  }

  const apiFormat = value.apiFormat === "responses" ? "responses" : "chat_completions";
  const continuation = normalizeAssistantContinuation(value.continuation);
  const usage = normalizeAssistantUsage(value.usage);
  const historyDelta = normalizeAssistantHistoryDelta(value.historyDelta);

  const emptyCompletion: NonNullable<AgentRoomTurn["meta"]>["emptyCompletion"] = isRecord(value.emptyCompletion)
    ? {
        createdAt: typeof value.emptyCompletion.createdAt === "string" ? value.emptyCompletion.createdAt : createTimestamp(),
        apiFormat: value.emptyCompletion.apiFormat === "responses" ? "responses" : "chat_completions",
        providerKey:
          value.emptyCompletion.providerKey === "right_codes"
            ? "right_codes"
            : value.emptyCompletion.providerKey === "generic"
              ? "generic"
              : "openai",
        providerLabel:
          typeof value.emptyCompletion.providerLabel === "string" && value.emptyCompletion.providerLabel
            ? value.emptyCompletion.providerLabel
            : compatibility.providerLabel,
        requestedModel: typeof value.emptyCompletion.requestedModel === "string" ? value.emptyCompletion.requestedModel : "",
        resolvedModel:
          typeof value.emptyCompletion.resolvedModel === "string" && value.emptyCompletion.resolvedModel
            ? value.emptyCompletion.resolvedModel
            : "",
        baseUrl:
          typeof value.emptyCompletion.baseUrl === "string" && value.emptyCompletion.baseUrl
            ? value.emptyCompletion.baseUrl
            : compatibility.baseUrl,
        textDeltaLength:
          typeof value.emptyCompletion.textDeltaLength === "number" && Number.isFinite(value.emptyCompletion.textDeltaLength)
            ? value.emptyCompletion.textDeltaLength
            : 0,
        finalTextLength:
          typeof value.emptyCompletion.finalTextLength === "number" && Number.isFinite(value.emptyCompletion.finalTextLength)
            ? value.emptyCompletion.finalTextLength
            : 0,
        toolCallCount:
          typeof value.emptyCompletion.toolCallCount === "number" && Number.isFinite(value.emptyCompletion.toolCallCount)
            ? value.emptyCompletion.toolCallCount
            : 0,
        toolEventCount:
          typeof value.emptyCompletion.toolEventCount === "number" && Number.isFinite(value.emptyCompletion.toolEventCount)
            ? value.emptyCompletion.toolEventCount
            : 0,
        ...(value.emptyCompletion.payloadMode === "sse" || value.emptyCompletion.payloadMode === "json" || value.emptyCompletion.payloadMode === "auto"
          ? {
              payloadMode:
                value.emptyCompletion.payloadMode === "sse"
                  ? "sse"
                  : value.emptyCompletion.payloadMode === "auto"
                    ? "auto"
                    : "json",
            }
          : {}),
        ...(typeof value.emptyCompletion.finishReason === "string" || value.emptyCompletion.finishReason === null
          ? {
              finishReason: value.emptyCompletion.finishReason,
            }
          : {}),
        ...(typeof value.emptyCompletion.responseId === "string" && value.emptyCompletion.responseId
          ? {
              responseId: value.emptyCompletion.responseId,
            }
          : {}),
        ...(typeof value.emptyCompletion.assistantContentShape === "string" && value.emptyCompletion.assistantContentShape
          ? {
              assistantContentShape: value.emptyCompletion.assistantContentShape,
            }
          : {}),
        ...(Array.isArray(value.emptyCompletion.outputItemTypes)
          ? {
              outputItemTypes: value.emptyCompletion.outputItemTypes.filter((item): item is string => typeof item === "string"),
            }
          : {}),
        ...(typeof value.emptyCompletion.chunkCount === "number" && Number.isFinite(value.emptyCompletion.chunkCount)
          ? {
              chunkCount: value.emptyCompletion.chunkCount,
            }
          : {}),
        ...(typeof value.emptyCompletion.sawDoneEvent === "boolean"
          ? {
              sawDoneEvent: value.emptyCompletion.sawDoneEvent,
            }
          : {}),
        ...(Array.isArray(value.emptyCompletion.chunkPreviews)
          ? {
              chunkPreviews: value.emptyCompletion.chunkPreviews.filter((item): item is string => typeof item === "string"),
            }
          : {}),
      }
    : undefined;

  const recovery: NonNullable<AgentRoomTurn["meta"]>["recovery"] = isRecord(value.recovery) && Array.isArray(value.recovery.attempts)
    ? {
        attempts: value.recovery.attempts.flatMap((attempt, index) => {
          if (!isRecord(attempt)) {
            return [];
          }

          const strategy =
            attempt.strategy === "resume_after_tools" || attempt.strategy === "retry_no_output"
              ? attempt.strategy
              : null;
          if (!strategy) {
            return [];
          }

          return [
            {
              attempt:
                typeof attempt.attempt === "number" && Number.isFinite(attempt.attempt)
                  ? Math.max(1, Math.round(attempt.attempt))
                  : index + 1,
              strategy,
              trigger: "finish_reason_error" as const,
              delayMs:
                typeof attempt.delayMs === "number" && Number.isFinite(attempt.delayMs)
                  ? Math.max(0, Math.round(attempt.delayMs))
                  : 0,
              toolEventCount:
                typeof attempt.toolEventCount === "number" && Number.isFinite(attempt.toolEventCount)
                  ? Math.max(0, Math.round(attempt.toolEventCount))
                  : 0,
              ...(typeof attempt.finishReason === "string" || attempt.finishReason === null
                ? {
                    finishReason: attempt.finishReason,
                  }
                : {}),
              ...(typeof attempt.chunkCount === "number" && Number.isFinite(attempt.chunkCount)
                ? {
                    chunkCount: Math.max(0, Math.round(attempt.chunkCount)),
                  }
                : {}),
              ...(typeof attempt.sawDoneEvent === "boolean"
                ? {
                    sawDoneEvent: attempt.sawDoneEvent,
                  }
                : {}),
              ...(Array.isArray(attempt.chunkPreviews)
                ? {
                    chunkPreviews: attempt.chunkPreviews.filter((item): item is string => typeof item === "string"),
                  }
                : {}),
            },
          ];
        }),
      }
    : undefined;

  return {
    apiFormat,
    compatibility,
    ...(typeof value.responseId === "string" && value.responseId
      ? {
          responseId: value.responseId,
        }
      : {}),
    ...(typeof value.sessionId === "string" && value.sessionId
      ? {
          sessionId: value.sessionId,
        }
      : {}),
    ...(continuation
      ? {
          continuation,
        }
      : {}),
    ...(usage
      ? {
          usage,
        }
      : {}),
    ...(historyDelta
      ? {
          historyDelta,
        }
      : {}),
    ...(emptyCompletion
      ? {
          emptyCompletion,
        }
      : {}),
    ...(recovery && recovery.attempts.length > 0
      ? {
          recovery,
        }
      : {}),
  };
}

function normalizeAgentTurn(value: unknown, fallbackAgentId: RoomAgentId): AgentRoomTurn | null {
  if (!isRecord(value)) {
    return null;
  }

  const fallbackAgent = getRoomAgent(fallbackAgentId);
  const userMessage = normalizeRoomMessage(value.userMessage, "user", "user");
  if (!userMessage) {
    return null;
  }

  const emittedMessages = Array.isArray(value.emittedMessages)
    ? value.emittedMessages
        .map((message) => normalizeRoomMessage(message, "assistant", "agent_emit"))
        .filter((message): message is RoomMessage => Boolean(message))
    : [];

  const tools = Array.isArray(value.tools)
    ? value.tools
        .map((tool, index) => normalizeToolExecution(tool, index))
        .filter((tool): tool is ToolExecution => Boolean(tool))
    : [];
  const timeline = Array.isArray(value.timeline)
    ? value.timeline
        .map((event, index) => normalizeTurnTimelineEvent(event, index))
        .filter((event): event is NonNullable<AgentRoomTurn["timeline"]>[number] => Boolean(event))
        .sort((left, right) => left.sequence - right.sequence)
    : [];
  const draftSegments = Array.isArray(value.draftSegments)
    ? value.draftSegments
        .map((segment, index) => normalizeDraftTextSegment(segment, index))
        .filter((segment): segment is NonNullable<AgentRoomTurn["draftSegments"]>[number] => Boolean(segment))
        .sort((left, right) => left.sequence - right.sequence)
    : [];

  return {
    id: typeof value.id === "string" && value.id ? value.id : createUuid(),
    agent: {
      id: normalizeRoomAgentId(isRecord(value.agent) ? value.agent.id : undefined),
      label:
        isRecord(value.agent) && typeof value.agent.label === "string" && value.agent.label
          ? value.agent.label
          : fallbackAgent.label,
    },
    userMessage: {
      ...userMessage,
      role: "user",
      source: "user",
      kind: "user_input",
      status: "completed",
      final: true,
      receiptStatus: userMessage.receiptStatus,
      receiptUpdatedAt: userMessage.receiptUpdatedAt,
    },
    ...(typeof value.anchorMessageId === "string" && value.anchorMessageId
      ? {
          anchorMessageId: value.anchorMessageId,
        }
      : {}),
    ...(typeof value.continuationSnapshot === "string" && value.continuationSnapshot
      ? {
          continuationSnapshot: value.continuationSnapshot,
        }
      : {}),
    assistantContent: typeof value.assistantContent === "string" ? value.assistantContent : "",
    ...(draftSegments.length > 0
      ? {
          draftSegments,
        }
      : {}),
    ...(timeline.length > 0
      ? {
          timeline,
        }
      : {}),
    tools,
    emittedMessages,
    status: isAgentTurnStatus(value.status) ? value.status : "completed",
    ...(normalizeAssistantMeta(value.meta)
      ? {
          meta: normalizeAssistantMeta(value.meta),
        }
      : {}),
    ...(typeof value.resolvedModel === "string" && value.resolvedModel
      ? {
          resolvedModel: value.resolvedModel,
        }
      : {}),
    ...(typeof value.error === "string" && value.error
      ? {
          error: value.error,
        }
      : {}),
  };
}

function normalizeSettings(value: unknown): ChatSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_SETTINGS };
  }

  return {
    modelConfigId: typeof value.modelConfigId === "string" && value.modelConfigId.trim() ? value.modelConfigId : null,
    apiFormat: value.apiFormat === "responses" ? "responses" : "chat_completions",
    model: typeof value.model === "string" ? value.model : "",
    systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : "",
    providerMode:
      value.providerMode === "openai" ||
      value.providerMode === "right_codes" ||
      value.providerMode === "generic" ||
      value.providerMode === "auto"
        ? value.providerMode
        : "auto",
    memoryBackend: "sqlite-fts",
    compactionTokenThreshold: coerceCompactionTokenThreshold(value.compactionTokenThreshold),
    compactionFreshTailCount: coerceCompactionFreshTailCount(value.compactionFreshTailCount),
    maxToolLoopSteps:
      value.maxToolLoopSteps === LEGACY_DEFAULT_MAX_TOOL_LOOP_STEPS
        ? DEFAULT_MAX_TOOL_LOOP_STEPS
        : coerceMaxToolLoopSteps(value.maxToolLoopSteps),
    thinkingLevel: coerceThinkingLevel(value.thinkingLevel),
    enabledSkillIds: coerceSkillIds(value.enabledSkillIds),
  };
}

function normalizeRoomSession(value: unknown, index: number): RoomSession | null {
  if (!isRecord(value)) {
    return null;
  }

  const agentId = normalizeRoomAgentId(value.agentId);
  const roomId = typeof value.id === "string" && value.id ? value.id : createUuid();
  const roomMessages = Array.isArray(value.roomMessages)
    ? value.roomMessages
        .map((message) => normalizeRoomMessage(message))
        .filter((message): message is RoomMessage => Boolean(message))
        .map((message) => ({
          ...message,
          seq: message.seq > 0 ? message.seq : 0,
          roomId: message.roomId || roomId,
        }))
    : [];
  const normalizedRoomMessages = roomMessages.map((message, messageIndex) => ({
    ...message,
    seq: message.seq > 0 ? message.seq : messageIndex + 1,
  }));
  const agentTurns = Array.isArray(value.agentTurns)
    ? value.agentTurns
        .map((turn) => normalizeAgentTurn(turn, agentId))
        .filter((turn): turn is AgentRoomTurn => Boolean(turn))
        .map((turn) => ({
          ...turn,
          userMessage: {
            ...turn.userMessage,
            roomId: turn.userMessage.roomId || roomId,
          },
          emittedMessages: turn.emittedMessages.map((message) => ({
            ...message,
            roomId: message.roomId || roomId,
          })),
        }))
    : [];
  const defaultTitle = getRoomIndexTitle(index);
  const participants = normalizeRoomParticipants(value.participants, agentId);
  const scheduler = normalizeScheduler(value.scheduler, participants);
  const ownerParticipantId = pickRoomOwnerParticipantId(
    participants,
    typeof value.ownerParticipantId === "string" && value.ownerParticipantId.trim() ? value.ownerParticipantId.trim() : null,
  );

  return {
    id: roomId,
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : defaultTitle,
    agentId: getPrimaryRoomAgentId({
      id: roomId,
      title: defaultTitle,
      agentId,
      archivedAt: null,
      ownerParticipantId,
      receiptRevision: 0,
      participants,
      scheduler,
      roomMessages: normalizedRoomMessages,
      agentTurns: [],
      error: "",
      createdAt: createTimestamp(),
      updatedAt: createTimestamp(),
    }),
    archivedAt: typeof value.archivedAt === "string" && value.archivedAt ? value.archivedAt : null,
    ownerParticipantId,
    receiptRevision:
      typeof value.receiptRevision === "number" && Number.isFinite(value.receiptRevision)
        ? Math.max(0, Math.round(value.receiptRevision))
        : 0,
    participants,
    scheduler,
    roomMessages: normalizedRoomMessages,
    agentTurns: dedupeAgentTurns(agentTurns),
    error: typeof value.error === "string" ? value.error : "",
    createdAt: typeof value.createdAt === "string" && value.createdAt ? value.createdAt : createTimestamp(),
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt ? value.updatedAt : createTimestamp(),
  };
}

function normalizeAgentSharedState(agentId: RoomAgentId, value: unknown): AgentSharedState {
  if (!isRecord(value)) {
    return createAgentSharedState();
  }

  const agentTurns = Array.isArray(value.agentTurns)
    ? value.agentTurns
        .map((turn) => normalizeAgentTurn(turn, agentId))
        .filter((turn): turn is AgentRoomTurn => Boolean(turn))
    : [];

  return createAgentSharedState({
    settings: normalizeSettings(value.settings),
    agentTurns: dedupeAgentTurns(agentTurns),
    resolvedModel: typeof value.resolvedModel === "string" ? value.resolvedModel : "",
    compatibility: normalizeCompatibility(value.compatibility),
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt ? value.updatedAt : createTimestamp(),
  });
}

function mergeLegacyRoomStateIntoAgentStates(
  current: Record<RoomAgentId, AgentSharedState>,
  roomLike: unknown,
): Record<RoomAgentId, AgentSharedState> {
  if (!isRecord(roomLike)) {
    return current;
  }

  const agentId = normalizeRoomAgentId(roomLike.agentId);
  const updatedAt = typeof roomLike.updatedAt === "string" && roomLike.updatedAt ? roomLike.updatedAt : createTimestamp();
  const normalizedRoom = normalizeRoomSession(roomLike, 0);

  return {
    ...current,
    [agentId]: createAgentSharedState({
      ...current[agentId],
      settings: normalizeSettings(roomLike.settings),
      agentTurns: mergeAgentTurns(current[agentId].agentTurns, normalizedRoom?.agentTurns ?? []),
      resolvedModel: typeof roomLike.resolvedModel === "string" ? roomLike.resolvedModel : current[agentId].resolvedModel,
      compatibility: normalizeCompatibility(roomLike.compatibility) ?? current[agentId].compatibility,
      updatedAt,
    }),
  };
}

function parseWorkspaceState(raw: string): RoomWorkspaceState | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.rooms)) {
      return null;
    }

    const rooms = parsed.rooms
      .map((room, index) => normalizeRoomSession(room, index + 1))
      .filter((room): room is RoomSession => Boolean(room));

    if (rooms.length === 0) {
      return null;
    }

    const parsedAgentStates = isRecord(parsed.agentStates) ? parsed.agentStates : {};
    const knownAgentIds = Object.keys(parsedAgentStates);
    let agentStates = createInitialAgentStates(
      knownAgentIds.length > 0 ? knownAgentIds.map((agentId) => getRoomAgent(agentId)) : ROOM_AGENTS,
    );
    for (const agentId of knownAgentIds) {
      agentStates[agentId] = normalizeAgentSharedState(agentId, parsedAgentStates[agentId]);
    }

    for (const room of Array.isArray(parsed.rooms) ? parsed.rooms : []) {
      agentStates = mergeLegacyRoomStateIntoAgentStates(agentStates, room);
    }

    const activeRoomId =
      typeof parsed.activeRoomId === "string" && rooms.some((room) => room.id === parsed.activeRoomId)
        ? parsed.activeRoomId
        : rooms[0].id;
    const selectedConsoleAgentId = isRoomAgentId(parsed.selectedConsoleAgentId)
      ? parsed.selectedConsoleAgentId.trim()
      : getPrimaryRoomAgentId(rooms.find((room) => room.id === activeRoomId) ?? rooms[0]);

    return {
      rooms: sortRoomsByUpdatedAt(
        rooms.map((room) => ({
          ...room,
          scheduler: {
            ...room.scheduler,
            status: "idle",
            activeParticipantId: null,
            roundCount: 0,
          },
          agentTurns: [],
        })),
      ),
      agentStates,
      activeRoomId,
      selectedConsoleAgentId,
    };
  } catch {
    return null;
  }
}

function migrateLegacyWorkspaceState(raw: string): RoomWorkspaceState | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const room = createRoomSession(1);
    const roomMessages = Array.isArray(parsed.roomMessages)
      ? parsed.roomMessages
          .map((message) => normalizeRoomMessage(message))
          .filter((message): message is RoomMessage => Boolean(message))
          .map((message, messageIndex) => ({
            ...message,
            seq: message.seq > 0 ? message.seq : messageIndex + 1,
          }))
      : [];
    const agentTurns = Array.isArray(parsed.agentTurns)
      ? parsed.agentTurns
          .map((turn) => normalizeAgentTurn(turn, room.agentId))
          .filter((turn): turn is AgentRoomTurn => Boolean(turn))
      : [];
    const firstUserContent = roomMessages.find((message) => message.role === "user")?.content || agentTurns[0]?.userMessage.content || "";
    const suggestedTitle = getSuggestedRoomTitle(firstUserContent);
    const agentStates = mergeLegacyRoomStateIntoAgentStates(createInitialAgentStates(), {
      agentId: room.agentId,
      settings: parsed.settings,
      resolvedModel: parsed.resolvedModel,
      compatibility: parsed.compatibility,
      updatedAt: createTimestamp(),
    });

    const migratedRoom: RoomSession = {
      ...room,
      title: suggestedTitle || room.title,
      archivedAt: null,
      roomMessages,
      agentTurns: [],
      updatedAt: createTimestamp(),
    };

    return {
      rooms: [migratedRoom],
      agentStates,
      activeRoomId: migratedRoom.id,
      selectedConsoleAgentId: migratedRoom.agentId,
    };
  } catch {
    return null;
  }
}

function getNextRoomIndex(rooms: RoomSession[]): number {
  return rooms.length + 1;
}

function getRoomAgentSummary(room: RoomSession): string {
  const enabledAgents = getEnabledAgentParticipants(room).length;
  const totalAgents = getAgentParticipants(room).length;
  if (totalAgents === 0) {
    return "0 agents";
  }

  return enabledAgents === totalAgents ? `${totalAgents} agents` : `${enabledAgents}/${totalAgents} agents`;
}

function getRoomHumanSummary(room: RoomSession): string {
  return `${getHumanParticipants(room).length} humans`;
}

function getCompatibilityModeLabel(compatibility: ProviderCompatibility | null): string {
  if (!compatibility) {
    return "等待首次请求后显示";
  }

  return compatibility.providerLabel;
}

function getCompatibilityDetailPills(compatibility: ProviderCompatibility | null): string[] {
  if (!compatibility) {
    return [];
  }

  return [
    `Chat: ${compatibility.chatCompletionsToolStyle}`,
    `Responses: ${compatibility.responsesContinuation}`,
    `Payload: ${compatibility.responsesPayloadMode}`,
  ];
}

function getToolStats(tools: ToolExecution[]) {
  const successCount = tools.filter((tool) => tool.status === "success").length;
  const errorCount = tools.length - successCount;

  return {
    total: tools.length,
    successCount,
    errorCount,
  };
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<RoomAgentDefinition[]>(ROOM_AGENTS);
  const [rooms, setRooms] = useState<RoomSession[]>([]);
  const [agentStates, setAgentStates] = useState<Record<RoomAgentId, AgentSharedState>>(createInitialAgentStates(ROOM_AGENTS));
  const [agentCompactionFeedback, setAgentCompactionFeedback] = useState<Record<RoomAgentId, AgentCompactionFeedback | null>>(
    createInitialAgentCompactionFeedback(ROOM_AGENTS),
  );
  const [activeRoomId, setActiveRoomId] = useState("");
  const [selectedConsoleAgentId, setSelectedConsoleAgentId] = useState<RoomAgentId | null>(null);
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const [selectedSenderByRoomId, setSelectedSenderByRoomId] = useState<Record<string, string>>({});
  const [draftsByRoomId, setDraftsByRoomId] = useState<Record<string, string>>({});
  const [pendingRoomCommandIds, setPendingRoomCommandIds] = useState<Record<string, boolean>>({});
  const [resettingAgentContextIds, setResettingAgentContextIds] = useState<Record<string, boolean>>({});
  const [compactingAgentContextIds, setCompactingAgentContextIds] = useState<Record<string, boolean>>({});
  const [hydrated, setHydrated] = useState(false);
  const agentsRef = useRef<RoomAgentDefinition[]>(ROOM_AGENTS);
  const roomsRef = useRef<RoomSession[]>([]);
  const agentStatesRef = useRef<Record<RoomAgentId, AgentSharedState>>(createInitialAgentStates(ROOM_AGENTS));
  const workspaceVersionRef = useRef(0);
  const activeRoomIdRef = useRef("");
  const selectedConsoleAgentIdRef = useRef<RoomAgentId | null>(null);
  const skipNextServerPersistRef = useRef(false);
  const workspacePersistTimerRef = useRef<number | null>(null);
  const pendingWorkspacePersistRef = useRef<RoomWorkspaceState | null>(null);
  const workspacePersistInFlightRef = useRef(false);
  const workspacePersistNonceRef = useRef(0);

  const applyWorkspaceSnapshot = useCallback(
    (
      snapshot: RoomWorkspaceState,
      version: number,
      options?: {
        skipServerPersist?: boolean;
      },
    ) => {
      if (options?.skipServerPersist) {
        skipNextServerPersistRef.current = true;
      }
      const nextRooms = (snapshot.rooms.length > 0 ? snapshot.rooms : [createRoomSession(1, DEFAULT_AGENT_ID, agentsRef.current)]).map((room) => ({
        ...room,
        roomMessages: dedupeRoomMessages(room.roomMessages),
      }));
      const nextAgentStates = ensureAgentStateMap(snapshot.agentStates, agentsRef.current, nextRooms);
      const nextActiveRoomId =
        snapshot.activeRoomId && nextRooms.some((room) => room.id === snapshot.activeRoomId)
          ? snapshot.activeRoomId
          : nextRooms[0]?.id ?? "";
      const nextSelectedConsoleAgentId = snapshot.selectedConsoleAgentId ?? getPrimaryRoomAgentId(nextRooms[0]);

      roomsRef.current = nextRooms;
      agentStatesRef.current = nextAgentStates;
      activeRoomIdRef.current = nextActiveRoomId;
      selectedConsoleAgentIdRef.current = nextSelectedConsoleAgentId;
      workspaceVersionRef.current = version;
      setRooms(nextRooms);
      setAgentStates(nextAgentStates);
      setAgentCompactionFeedback((current) => ensureAgentFeedbackMap(current, agentsRef.current, nextAgentStates));
      setActiveRoomId(nextActiveRoomId);
      setSelectedConsoleAgentId(nextSelectedConsoleAgentId);
      setWorkspaceVersion(version);
      setHydrated(true);
    },
    [],
  );

  const applyWorkspaceEnvelope = useCallback(
    (envelope: { version?: number; state?: RoomWorkspaceState } | null | undefined) => {
      if (!envelope?.state || typeof envelope.version !== "number") {
        throw new Error("Room command did not return a valid workspace snapshot.");
      }

      applyWorkspaceSnapshot(envelope.state, envelope.version, { skipServerPersist: true });
      return envelope.state;
    },
    [applyWorkspaceSnapshot],
  );

  const applyWorkspaceStreamEvent = useCallback(
    (event: WorkspaceStreamEvent) => {
      if (event.type === "snapshot") {
        applyWorkspaceSnapshot(event.state, event.version, { skipServerPersist: true });
        return;
      }

      const baseState: RoomWorkspaceState = {
        rooms: roomsRef.current,
        agentStates: agentStatesRef.current,
        activeRoomId: activeRoomIdRef.current,
        ...(selectedConsoleAgentIdRef.current
          ? {
              selectedConsoleAgentId: selectedConsoleAgentIdRef.current,
            }
          : {}),
      };
      const nextState = applyWorkspaceStatePatch(baseState, event.patch);
      applyWorkspaceSnapshot(nextState, event.version, { skipServerPersist: true });
    },
    [applyWorkspaceSnapshot],
  );

  const runRoomCommandRequest = useCallback(
    async (
      payload: Record<string, unknown>,
      options?: {
        pendingRoomId?: string;
      },
    ) => {
      if (options?.pendingRoomId) {
        setPendingRoomCommandIds((current) => ({
          ...current,
          [options.pendingRoomId as string]: true,
        }));
      }

      try {
        const response = await postRoomCommand(payload);
        if (!response?.ok) {
          throw new Error(response?.error ?? "Room command failed.");
        }

        return applyWorkspaceEnvelope(response.envelope);
      } finally {
        if (options?.pendingRoomId) {
          setPendingRoomCommandIds((current) => {
            const nextState = { ...current };
            delete nextState[options.pendingRoomId as string];
            return nextState;
          });
        }
      }
    },
    [applyWorkspaceEnvelope],
  );

  const refreshWorkspaceFromServer = useCallback(async () => {
    const payload = await fetchWorkspaceEnvelope();
    if (typeof payload?.version !== "number" || !payload.state) {
      return null;
    }

    if (payload.version >= workspaceVersionRef.current) {
      applyWorkspaceSnapshot(payload.state, payload.version, { skipServerPersist: true });
    }

    return payload;
  }, [applyWorkspaceSnapshot]);

  const handleAgentsLoaded = useCallback((nextAgents: RoomAgentDefinition[]) => {
    setAgents(nextAgents);
    setAgentStates((current) => ensureAgentStateMap(current, nextAgents, roomsRef.current));
    setAgentCompactionFeedback((current) => ensureAgentFeedbackMap(current, nextAgents, agentStatesRef.current));
  }, []);

  useWorkspaceHydration({
    agentsRef,
    applyWorkspaceSnapshot,
    fetchAgentDefinitions,
    parseWorkspaceState,
    migrateLegacyWorkspaceState,
    onAgentsLoaded: handleAgentsLoaded,
  });

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    const availableRooms = getActiveRooms(rooms);
    if (availableRooms.length === 0) {
      const fallbackRoom = createRoomSession(getNextRoomIndex(roomsRef.current), DEFAULT_AGENT_ID, agentsRef.current);
      const nextRooms = sortRoomsByUpdatedAt([fallbackRoom, ...roomsRef.current]);
      roomsRef.current = nextRooms;
      setRooms(nextRooms);
      setActiveRoomId(fallbackRoom.id);
      setSelectedConsoleAgentId(fallbackRoom.agentId);
      return;
    }

    if (!availableRooms.some((room) => room.id === activeRoomId)) {
      setActiveRoomId(availableRooms[0].id);
    }
  }, [activeRoomId, hydrated, rooms]);

  useBrowserWorkspaceCache({
    hydrated,
    rooms,
    agentStates,
    activeRoomId,
    selectedConsoleAgentId,
  });

  useEffect(() => {
    workspaceVersionRef.current = workspaceVersion;
  }, [workspaceVersion]);

  useEffect(() => {
    activeRoomIdRef.current = activeRoomId;
  }, [activeRoomId]);

  useEffect(() => {
    selectedConsoleAgentIdRef.current = selectedConsoleAgentId;
  }, [selectedConsoleAgentId]);

  useEffect(() => {
    agentsRef.current = agents;
    setAgentStates((current) => {
      const nextState = ensureAgentStateMap(current, agents, roomsRef.current);
      agentStatesRef.current = nextState;
      return nextState;
    });
    setAgentCompactionFeedback((current) => ensureAgentFeedbackMap(current, agents, agentStatesRef.current));
  }, [agents]);

  useWorkspacePersistence({
    hydrated,
    rooms,
    agentStates,
    activeRoomId,
    selectedConsoleAgentId,
    roomsRef,
    agentStatesRef,
    activeRoomIdRef,
    selectedConsoleAgentIdRef,
    workspaceVersionRef,
    skipNextServerPersistRef,
    workspacePersistTimerRef,
    pendingWorkspacePersistRef,
    workspacePersistInFlightRef,
    workspacePersistNonceRef,
    applyWorkspaceSnapshot,
    setWorkspaceVersion,
  });

  useWorkspaceStreamSync({
    hydrated,
    workspaceVersionRef,
    applyWorkspaceStreamEvent,
    refreshWorkspaceFromServer,
  });

  useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);

  useEffect(() => {
    agentStatesRef.current = agentStates;
  }, [agentStates]);

  useEffect(() => {
    activeRoomIdRef.current = activeRoomId;
  }, [activeRoomId]);

  useEffect(() => {
    selectedConsoleAgentIdRef.current = selectedConsoleAgentId ?? null;
  }, [selectedConsoleAgentId]);

  const updateAgentState = useCallback((agentId: RoomAgentId, updater: (state: AgentSharedState) => AgentSharedState) => {
    setAgentStates((current) => {
      const nextState = {
        ...current,
        [agentId]: updater(current[agentId] ?? createAgentSharedState()),
      };
      agentStatesRef.current = nextState;
      return nextState;
    });
  }, []);

  const updateRoomStateEphemeral = useCallback(
    (roomId: string, updater: (room: RoomSession) => RoomSession) => {
      skipNextServerPersistRef.current = true;
      setRooms((current) => {
        let changed = false;
        const nextRooms = current.map((room) => {
          if (room.id !== roomId) {
            return room;
          }

          const updatedRoom = updater(room);
          const dedupedMessages = dedupeRoomMessages(updatedRoom.roomMessages);
          const nextRoom = dedupedMessages === updatedRoom.roomMessages
            ? updatedRoom
            : {
                ...updatedRoom,
                roomMessages: dedupedMessages,
              };

          if (nextRoom === room) {
            return room;
          }

          changed = true;
          return nextRoom;
        });

        if (!changed) {
          return current;
        }

        roomsRef.current = nextRooms;
        return nextRooms;
      });
    },
    [],
  );

  const updateAgentTurnsEphemeral = useCallback(
    (agentId: RoomAgentId, updater: (turns: AgentRoomTurn[]) => AgentRoomTurn[]) => {
      skipNextServerPersistRef.current = true;
      setAgentStates((current) => {
        const state = current[agentId] ?? createAgentSharedState();
        const nextState = {
          ...current,
          [agentId]: {
            ...state,
            agentTurns: sortAgentTurnsByUserMessageTime(updater(state.agentTurns)),
            updatedAt: createTimestamp(),
          },
        };
        agentStatesRef.current = nextState;
        return nextState;
      });
    },
    [],
  );

  const applyReceiptUpdateToAllAgentConsolesEphemeral = useCallback(
    (update: RoomMessageReceiptUpdate) => {
      skipNextServerPersistRef.current = true;
      setAgentStates((current) => {
        let changed = false;
        const nextState = { ...current };

        for (const agentId of Object.keys(current) as RoomAgentId[]) {
          const state = current[agentId];
          const nextTurns = state.agentTurns.map((turn) => {
            if (turn.userMessage.id !== update.messageId) {
              return turn;
            }

            changed = true;
            const nextMessages = applyMessageReceiptUpdate([turn.userMessage], update);
            return {
              ...turn,
              userMessage: nextMessages[0] ?? turn.userMessage,
            };
          });

          if (nextTurns !== state.agentTurns) {
            nextState[agentId] = {
              ...state,
              agentTurns: sortAgentTurnsByUserMessageTime(nextTurns),
              updatedAt: createTimestamp(),
            };
          }
        }

        if (changed) {
          agentStatesRef.current = nextState;
          return nextState;
        }

        return current;
      });
    },
    [],
  );

  const getAgentDefinition = useCallback((agentId: RoomAgentId): RoomAgentDefinition => {
    return getRoomAgent(agentId, agentsRef.current);
  }, []);

  const activeRooms = useMemo(() => getActiveRooms(rooms), [rooms]);
  const archivedRooms = useMemo(() => getArchivedRooms(rooms), [rooms]);
  const activeRoom = useMemo(
    () => activeRooms.find((room) => room.id === activeRoomId) ?? activeRooms[0] ?? null,
    [activeRoomId, activeRooms],
  );

  useEffect(() => {
    if (selectedConsoleAgentId === null && activeRoom) {
      setSelectedConsoleAgentId(getPrimaryRoomAgentId(activeRoom));
    }
  }, [activeRoom, selectedConsoleAgentId]);

  const setSelectedSender = useCallback((roomId: string, participantId: string) => {
    setSelectedSenderByRoomId((current) => ({
      ...current,
      [roomId]: participantId,
    }));
  }, []);

  const setDraft = useCallback((roomId: string, value: string) => {
    setDraftsByRoomId((current) => ({
      ...current,
      [roomId]: value,
    }));
  }, []);

  const clearDraftForRoom = useCallback((roomId: string) => {
    setDraftsByRoomId((current) => {
      const nextState = { ...current };
      delete nextState[roomId];
      return nextState;
    });
  }, []);

  const { streamingAgentIdsByRoomId, stopRoom, sendMessage } = useRoomStreamingSend({
    defaultLocalParticipantId: DEFAULT_LOCAL_PARTICIPANT_ID,
    roomsRef,
    runRoomCommandRequest,
    refreshWorkspaceFromServer,
    clearDraftForRoom,
    setActiveRoomId,
    setSelectedSender,
    setPendingRoomCommandIds,
    updateAgentState,
    updateAgentTurnsEphemeral,
    updateRoomStateEphemeral,
    applyReceiptUpdateToAllAgentConsolesEphemeral,
    normalizeAssistantMeta,
  });

  const {
    createRoom,
    renameRoom,
    archiveRoom,
    restoreRoom,
    deleteRoom,
    clearRoom,
    clearRoomLogs,
    addHumanParticipant,
    addAgentParticipant,
    removeParticipant,
    toggleAgentParticipant,
    moveAgentParticipant,
  } = useRoomCommands({
    defaultAgentId: DEFAULT_AGENT_ID,
    defaultLocalParticipantId: DEFAULT_LOCAL_PARTICIPANT_ID,
    agentsRef,
    runRoomCommandRequest,
    clearDraftForRoom,
    setActiveRoomId,
    setSelectedConsoleAgentId,
    setSelectedSenderByRoomId,
  });

  const runningAgentRequestIds = useMemo(() => {
    const nextState: Record<string, string> = {};

    for (const room of rooms) {
      if (room.scheduler.status !== "running") {
        continue;
      }

      const activeParticipant = room.participants.find((participant) => participant.id === room.scheduler.activeParticipantId);
      if (activeParticipant?.agentId) {
        nextState[activeParticipant.agentId] = room.id;
      }
    }

    for (const [roomId, agentId] of Object.entries(streamingAgentIdsByRoomId)) {
      nextState[agentId] = roomId;
    }

    return nextState;
  }, [rooms, streamingAgentIdsByRoomId]);

  const clearAllWorkspace = useCallback(async () => {
    const initialRoom = createRoomSession(1, DEFAULT_AGENT_ID, agentsRef.current);
    const initialAgentStates = createInitialAgentStates(agentsRef.current);

    roomsRef.current = [initialRoom];
    agentStatesRef.current = initialAgentStates;

    setRooms([initialRoom]);
    setAgentStates(initialAgentStates);
    setAgentCompactionFeedback(createInitialAgentCompactionFeedback(agentsRef.current));
    setActiveRoomId(initialRoom.id);
    setSelectedConsoleAgentId(initialRoom.agentId);
    setSelectedSenderByRoomId({});
    setDraftsByRoomId({});
    setResettingAgentContextIds({});
    setCompactingAgentContextIds({});

    await clearPersistedWorkspaceState();

    await Promise.allSettled(
      agentsRef.current.map((agent) =>
        fetch("/api/agent-memory/reset", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ agentId: agent.id }),
        }),
      ),
    );
  }, []);

  const clearAgentConsole = useCallback(
    (agentId: RoomAgentId) => {
      if (runningAgentRequestIds[agentId]) {
        return;
      }

      updateAgentState(agentId, (state) => ({
        ...state,
        agentTurns: [],
        updatedAt: createTimestamp(),
      }));
    },
    [runningAgentRequestIds, updateAgentState],
  );

  const resetAgentContext = useCallback(
    async (agentId: RoomAgentId) => {
      if (runningAgentRequestIds[agentId] || resettingAgentContextIds[agentId]) {
        return;
      }

      setResettingAgentContextIds((current) => ({
        ...current,
        [agentId]: true,
      }));

      try {
        const response = await fetch("/api/agent-memory/reset", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ agentId }),
        });

        if (!response.ok) {
          throw new Error("Failed to reset agent context.");
        }

        updateAgentState(agentId, (state) => ({
          ...state,
          agentTurns: [],
          updatedAt: createTimestamp(),
        }));
      } finally {
        setResettingAgentContextIds((current) => {
          const next = { ...current };
          delete next[agentId];
          return next;
        });
      }
    },
    [resettingAgentContextIds, runningAgentRequestIds, updateAgentState],
  );

  const compactAgentContext = useCallback(
    async (agentId: RoomAgentId) => {
      if (runningAgentRequestIds[agentId] || compactingAgentContextIds[agentId]) {
        return;
      }

      setCompactingAgentContextIds((current) => ({
        ...current,
        [agentId]: true,
      }));

      try {
        const response = await fetch("/api/agent-memory/compact", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ agentId }),
        });

        const payload = (await response.json().catch(() => null)) as
          | {
              compacted?: boolean;
              record?: {
                summary?: string;
                prunedMessages?: number;
                charsBefore?: number;
                charsAfter?: number;
              } | null;
              error?: string;
            }
          | null;

        if (!response.ok) {
          throw new Error(payload?.error || "Failed to compact agent context.");
        }

        const summary = payload?.record?.summary?.trim() || "";
        const feedback: AgentCompactionFeedback = payload?.compacted
          ? {
              status: "success",
              message:
                typeof payload.record?.prunedMessages === "number"
                  ? `已压缩 ${payload.record.prunedMessages} 条隐藏历史消息。`
                  : "已压缩隐藏上下文。",
              summary,
              updatedAt: createTimestamp(),
            }
          : {
              status: "noop",
              message: "当前没有足够的隐藏上下文可压缩。",
              summary,
              updatedAt: createTimestamp(),
            };

        setAgentCompactionFeedback((current) => ({
          ...current,
          [agentId]: feedback,
        }));

        updateAgentState(agentId, (state) => ({
          ...state,
          updatedAt: createTimestamp(),
        }));
      } catch (error) {
        setAgentCompactionFeedback((current) => ({
          ...current,
          [agentId]: {
            status: "error",
            message: error instanceof Error ? error.message : "压缩隐藏上下文时发生未知错误。",
            summary: "",
            updatedAt: createTimestamp(),
          },
        }));
      } finally {
        setCompactingAgentContextIds((current) => {
          const next = { ...current };
          delete next[agentId];
          return next;
        });
      }
    },
    [compactingAgentContextIds, runningAgentRequestIds, updateAgentState],
  );

  const updateAgentSettings = useCallback(
    (agentId: RoomAgentId, patch: Partial<ChatSettings>) => {
      updateAgentState(agentId, (state) => ({
        ...state,
        settings: {
          ...state.settings,
          ...patch,
          memoryBackend: "sqlite-fts" as MemoryBackendId,
          compactionTokenThreshold: coerceCompactionTokenThreshold(patch.compactionTokenThreshold ?? state.settings.compactionTokenThreshold),
          compactionFreshTailCount: coerceCompactionFreshTailCount(patch.compactionFreshTailCount ?? state.settings.compactionFreshTailCount),
          maxToolLoopSteps: coerceMaxToolLoopSteps(patch.maxToolLoopSteps ?? state.settings.maxToolLoopSteps),
          thinkingLevel: coerceThinkingLevel(patch.thinkingLevel ?? state.settings.thinkingLevel),
          enabledSkillIds: coerceSkillIds(patch.enabledSkillIds ?? state.settings.enabledSkillIds),
        },
        updatedAt: createTimestamp(),
      }));
    },
    [updateAgentState],
  );

  const createAgentDefinition = useCallback(async (input: AgentMutationInput) => {
    const agent = await createAgentDefinitionRequest({
      ...input,
      id: input.id.trim(),
      label: input.label.trim(),
      summary: input.summary.trim(),
      workingStyle: input.workingStyle.trim(),
      skills: [...new Set((input.skills ?? []).map((skill) => skill.trim()).filter(Boolean))],
      instruction: input.instruction,
    });
    setAgents((current) => {
      const nextAgents = [...current.filter((entry) => entry.id !== agent.id), agent].sort((left, right) => left.label.localeCompare(right.label));
      agentsRef.current = nextAgents;
      return nextAgents;
    });
    updateAgentState(agent.id, (state) => state);
    setAgentCompactionFeedback((current) => ({
      ...current,
      [agent.id]: current[agent.id] ?? null,
    }));
    return agent;
  }, [updateAgentState]);

  const updateAgentDefinition = useCallback(async (agentId: RoomAgentId, patch: AgentUpdateInput) => {
    const agent = await updateAgentDefinitionRequest(agentId, {
      ...patch,
      ...(typeof patch.label === "string" ? { label: patch.label.trim() } : {}),
      ...(typeof patch.summary === "string" ? { summary: patch.summary.trim() } : {}),
      ...(typeof patch.workingStyle === "string" ? { workingStyle: patch.workingStyle.trim() } : {}),
      ...(Array.isArray(patch.skills)
        ? {
            skills: [...new Set(patch.skills.map((skill) => skill.trim()).filter(Boolean))],
          }
        : {}),
    });
    setAgents((current) => {
      const nextAgents = current.map((entry) => (entry.id === agent.id ? agent : entry));
      agentsRef.current = nextAgents;
      return nextAgents;
    });
    return agent;
  }, []);

  const getRoomById = useCallback((roomId: string) => {
    return roomsRef.current.find((room) => room.id === roomId) ?? null;
  }, []);

  const isAgentRunning = useCallback(
    (agentId: RoomAgentId) => {
      if (runningAgentRequestIds[agentId]) {
        return true;
      }

      return roomsRef.current.some((room) => {
        if (room.scheduler.status !== "running") {
          return false;
        }

        const activeParticipant = room.participants.find((participant) => participant.id === room.scheduler.activeParticipantId);
        return activeParticipant?.agentId === agentId;
      });
    },
    [runningAgentRequestIds],
  );

  const isAgentCompacting = useCallback(
    (agentId: RoomAgentId) => {
      return Boolean(compactingAgentContextIds[agentId]);
    },
    [compactingAgentContextIds],
  );

  const isRoomRunning = useCallback(
    (roomId: string) => {
      const room = roomsRef.current.find((entry) => entry.id === roomId);
      return room ? room.scheduler.status === "running" || Boolean(pendingRoomCommandIds[roomId]) : Boolean(pendingRoomCommandIds[roomId]);
    },
    [pendingRoomCommandIds],
  );

  const roomsContextValue = useMemo<WorkspaceRoomsContextValue>(
    () => ({
      hydrated,
      rooms,
      activeRooms,
      archivedRooms,
      activeRoomId,
      activeRoom,
      selectedSenderByRoomId,
      draftsByRoomId,
    }),
    [activeRoom, activeRoomId, activeRooms, archivedRooms, draftsByRoomId, hydrated, rooms, selectedSenderByRoomId],
  );

  const agentsContextValue = useMemo<WorkspaceAgentsContextValue>(
    () => ({
      agents,
      agentStates,
      agentCompactionFeedback,
      runningAgentRequestIds,
      selectedConsoleAgentId,
    }),
    [agents, agentCompactionFeedback, agentStates, runningAgentRequestIds, selectedConsoleAgentId],
  );

  const actionsContextValue = useMemo<WorkspaceActionsContextValue>(
    () => ({
      setActiveRoomId,
      setSelectedConsoleAgentId,
      setSelectedSender,
      setDraft,
      getAgentDefinition,
      getRoomById,
      isAgentRunning,
      isAgentCompacting,
      isRoomRunning,
      createRoom,
      createAgentDefinition,
      renameRoom,
      archiveRoom,
      restoreRoom,
      deleteRoom,
      clearRoom,
      clearRoomLogs,
      addHumanParticipant,
      addAgentParticipant,
      removeParticipant,
      toggleAgentParticipant,
      moveAgentParticipant,
      stopRoom,
      sendMessage,
      clearAllWorkspace,
      clearAgentConsole,
      resetAgentContext,
      compactAgentContext,
      updateAgentSettings,
      updateAgentDefinition,
    }),
    [
      addAgentParticipant,
      addHumanParticipant,
      archiveRoom,
      clearAgentConsole,
      compactAgentContext,
      clearRoom,
      clearRoomLogs,
      createRoom,
      deleteRoom,
      getAgentDefinition,
      getRoomById,
      isAgentRunning,
      isAgentCompacting,
      isRoomRunning,
      moveAgentParticipant,
      stopRoom,
      removeParticipant,
      resetAgentContext,
      renameRoom,
      restoreRoom,
      sendMessage,
      clearAllWorkspace,
      createAgentDefinition,
      setDraft,
      setSelectedSender,
      toggleAgentParticipant,
      updateAgentSettings,
      updateAgentDefinition,
    ],
  );

  return (
    <WorkspaceRoomsContext.Provider value={roomsContextValue}>
      <WorkspaceAgentsContext.Provider value={agentsContextValue}>
        <WorkspaceActionsContext.Provider value={actionsContextValue}>{children}</WorkspaceActionsContext.Provider>
      </WorkspaceAgentsContext.Provider>
    </WorkspaceRoomsContext.Provider>
  );
}

export function useWorkspaceRoomsState() {
  const context = useContext(WorkspaceRoomsContext);
  if (!context) {
    throw new Error("useWorkspace must be used inside WorkspaceProvider.");
  }

  return context;
}

export function useWorkspaceAgentsState() {
  const context = useContext(WorkspaceAgentsContext);
  if (!context) {
    throw new Error("useWorkspace must be used inside WorkspaceProvider.");
  }

  return context;
}

export function useWorkspaceActions() {
  const context = useContext(WorkspaceActionsContext);
  if (!context) {
    throw new Error("useWorkspace must be used inside WorkspaceProvider.");
  }

  return context;
}

export function useWorkspaceAgents() {
  return useWorkspaceAgentsState().agents;
}

export function useWorkspace() {
  return {
    ...useWorkspaceRoomsState(),
    ...useWorkspaceAgentsState(),
    ...useWorkspaceActions(),
  };
}

export { formatTimestamp } from "@/lib/chat/workspace-domain";

export {
  DEFAULT_AGENT_ID,
  MAX_MAX_TOOL_LOOP_STEPS,
  MIN_MAX_TOOL_LOOP_STEPS,
  getActiveRooms,
  getAgentParticipants,
  getCompatibilityDetailPills,
  getCompatibilityModeLabel,
  getEnabledAgentParticipants,
  getHumanParticipants,
  getPrimaryRoomAgentId,
  getReceiptInlineNote,
  getRoomAgent,
  getRoomAgentSummary,
  getRoomHumanSummary,
  getRoomPreview,
  getToolStats,
  ROOM_AGENTS,
  type WorkspaceContextValue,
};
