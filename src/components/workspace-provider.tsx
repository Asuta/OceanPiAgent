"use client";

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
  AgentInfoCard,
  AgentRoomTurn,
  AgentSharedState,
  AttachedRoomDefinition,
  ChatSettings,
  ProviderCompatibility,
  RoomHistoryMessageSummary,
  RoomAgentDefinition,
  RoomAgentId,
  RoomChatResponseBody,
  RoomChatStreamEvent,
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
  coerceSkillIds,
  coerceThinkingLevel,
  coerceMaxToolLoopSteps,
  DEFAULT_MAX_TOOL_LOOP_STEPS,
  MAX_MAX_TOOL_LOOP_STEPS,
  MIN_MAX_TOOL_LOOP_STEPS,
} from "@/lib/chat/types";

const STORAGE_KEY = "oceanking.room-shell.v4";
const PREVIOUS_STORAGE_KEY = "oceanking.room-shell.v3";
const LEGACY_STORAGE_KEY = "oceanking.room-shell.v1";
const DEFAULT_AGENT_ID: RoomAgentId = "concierge";
const ROOM_LOOP_MAX_ROUNDS = 20;
const DEFAULT_LOCAL_PARTICIPANT_ID = "local-operator";

const DEFAULT_SETTINGS: ChatSettings = {
  apiFormat: "chat_completions",
  model: "",
  systemPrompt: "",
  providerMode: "auto",
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

const ROOM_SCHEDULER_SENDER: RoomSender = {
  id: "room-scheduler",
  name: "Room Scheduler",
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

interface ActiveRoomRun {
  roomId: string;
  requestId: string;
  turnId: string;
  controller: AbortController;
}

interface ActiveSchedulerRun {
  cycleId: string;
  activeAgentId: RoomAgentId | null;
  activeRequestId: string | null;
}

interface ExecuteAgentTurnResult {
  status: "completed" | "superseded" | "aborted" | "error";
  emittedMessages: RoomMessage[];
  receiptUpdates: RoomMessageReceiptUpdate[];
}

interface SendMessageArgs {
  roomId: string;
  content: string;
  senderId?: string;
}

interface WorkspaceContextValue {
  hydrated: boolean;
  rooms: RoomSession[];
  activeRooms: RoomSession[];
  archivedRooms: RoomSession[];
  activeRoomId: string;
  activeRoom: RoomSession | null;
  agentStates: Record<RoomAgentId, AgentSharedState>;
  runningAgentRequestIds: Record<string, string>;
  selectedConsoleAgentId: RoomAgentId | null;
  selectedSenderByRoomId: Record<string, string>;
  draftsByRoomId: Record<string, string>;
  setActiveRoomId: (roomId: string) => void;
  setSelectedConsoleAgentId: (agentId: RoomAgentId) => void;
  setSelectedSender: (roomId: string, participantId: string) => void;
  setDraft: (roomId: string, value: string) => void;
  getRoomById: (roomId: string) => RoomSession | null;
  isAgentRunning: (agentId: RoomAgentId) => boolean;
  isRoomRunning: (roomId: string) => boolean;
  createRoom: (agentId?: RoomAgentId) => RoomSession;
  renameRoom: (roomId: string, title: string) => void;
  archiveRoom: (roomId: string) => void;
  restoreRoom: (roomId: string) => void;
  deleteRoom: (roomId: string) => void;
  clearRoom: (roomId: string) => void;
  addHumanParticipant: (roomId: string, name: string) => void;
  addAgentParticipant: (roomId: string, agentId: RoomAgentId) => void;
  removeParticipant: (roomId: string, participantId: string) => void;
  toggleAgentParticipant: (roomId: string, participantId: string) => void;
  moveAgentParticipant: (roomId: string, participantId: string, direction: -1 | 1) => void;
  sendMessage: (args: SendMessageArgs) => Promise<void>;
  clearAllWorkspace: () => Promise<void>;
  clearAgentConsole: (agentId: RoomAgentId) => void;
  resetAgentContext: (agentId: RoomAgentId) => Promise<void>;
  compactAgentContext: (agentId: RoomAgentId) => Promise<void>;
  updateAgentSettings: (agentId: RoomAgentId, patch: Partial<ChatSettings>) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

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

function createTimestamp(): string {
  return new Date().toISOString();
}

function sortRoomsByUpdatedAt(rooms: RoomSession[]): RoomSession[] {
  return [...rooms].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function sortAgentTurnsByUserMessageTime(turns: AgentRoomTurn[]): AgentRoomTurn[] {
  return [...turns].sort((left, right) => {
    const leftTime = Date.parse(left.userMessage.createdAt || "");
    const rightTime = Date.parse(right.userMessage.createdAt || "");

    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
      return 0;
    }

    if (Number.isNaN(leftTime)) {
      return 1;
    }

    if (Number.isNaN(rightTime)) {
      return -1;
    }

    return leftTime - rightTime;
  });
}

function mergeAgentTurns(...turnGroups: AgentRoomTurn[][]): AgentRoomTurn[] {
  const turnsById = new Map<string, AgentRoomTurn>();

  for (const turns of turnGroups) {
    for (const turn of turns) {
      turnsById.set(turn.id, turn);
    }
  }

  return sortAgentTurnsByUserMessageTime([...turnsById.values()]);
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

function shouldAutoTitleRoom(room: RoomSession): boolean {
  return /^Room \d+$/.test(room.title) && room.roomMessages.length === 0 && room.agentTurns.length === 0;
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

function getReceiptStatus(receipts: RoomMessageReceipt[]): RoomMessage["receiptStatus"] {
  return receipts.length > 0 ? "read_no_reply" : "none";
}

function getReceiptUpdatedAt(receipts: RoomMessageReceipt[]): string | null {
  return receipts[receipts.length - 1]?.createdAt ?? null;
}

function upsertRoomMessageReceipt(receipts: RoomMessageReceipt[], receipt: RoomMessageReceipt): RoomMessageReceipt[] {
  if (receipts.some((entry) => entry.participantId === receipt.participantId)) {
    return receipts;
  }

  const nextReceipts = receipts.filter((entry) => entry.participantId !== receipt.participantId);
  nextReceipts.push(receipt);
  return sortRoomMessageReceipts(nextReceipts);
}

function formatReceiptSummary(receipts: RoomMessageReceipt[]): string {
  return sortRoomMessageReceipts(receipts)
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

function createParticipantId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function getRoomAgent(agentId: RoomAgentId): RoomAgentDefinition {
  return ROOM_AGENTS.find((agent) => agent.id === agentId) ?? ROOM_AGENTS[0];
}

function createAgentSharedState(overrides?: Partial<AgentSharedState>): AgentSharedState {
  const timestamp = createTimestamp();
  return {
    settings: { ...DEFAULT_SETTINGS },
    agentTurns: [],
    resolvedModel: "",
    compatibility: null,
    updatedAt: timestamp,
    ...overrides,
  };
}

function createInitialAgentStates(): Record<RoomAgentId, AgentSharedState> {
  return {
    concierge: createAgentSharedState(),
    researcher: createAgentSharedState(),
    operator: createAgentSharedState(),
  };
}

function createHumanParticipant(name: string, id = DEFAULT_LOCAL_PARTICIPANT_ID): RoomParticipant {
  const timestamp = createTimestamp();
  return {
    id,
    name,
    senderRole: "participant",
    runtimeKind: "human",
    enabled: true,
    order: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createAgentParticipant(agentId: RoomAgentId, order: number): RoomParticipant {
  const timestamp = createTimestamp();
  const agent = getRoomAgent(agentId);
  return {
    id: agentId,
    name: agent.label,
    senderRole: "participant",
    runtimeKind: "agent",
    enabled: true,
    order,
    agentId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function pickRoomOwnerParticipantId(participants: RoomParticipant[], preferredOwnerId?: string | null): string | null {
  if (preferredOwnerId && participants.some((participant) => participant.id === preferredOwnerId)) {
    return preferredOwnerId;
  }

  if (participants.length === 0) {
    return null;
  }

  const sortedByJoinTime = [...participants].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt || "");
    const rightTime = Date.parse(right.createdAt || "");

    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
      return left.name.localeCompare(right.name);
    }

    if (Number.isNaN(leftTime)) {
      return 1;
    }

    if (Number.isNaN(rightTime)) {
      return -1;
    }

    return leftTime - rightTime || left.name.localeCompare(right.name);
  });

  return sortedByJoinTime[0]?.id ?? null;
}

function getRoomOwnerParticipant(room: RoomSession): RoomParticipant | null {
  if (!room.ownerParticipantId) {
    return null;
  }

  return room.participants.find((participant) => participant.id === room.ownerParticipantId) ?? null;
}

function getParticipantMembershipRole(room: RoomSession, participantId: string): "owner" | "member" {
  return room.ownerParticipantId === participantId ? "owner" : "member";
}

function sortRoomParticipants(participants: RoomParticipant[]): RoomParticipant[] {
  const humans = participants.filter((participant) => participant.runtimeKind === "human");
  const agents = [...participants.filter((participant) => participant.runtimeKind === "agent")].sort(
    (left, right) => left.order - right.order || left.name.localeCompare(right.name),
  );

  return [
    ...humans,
    ...agents.map((participant, index) => ({
      ...participant,
      order: index + 1,
    })),
  ];
}

function getAgentParticipants(room: RoomSession): RoomParticipant[] {
  return room.participants.filter((participant) => participant.runtimeKind === "agent");
}

function getEnabledAgentParticipants(room: RoomSession): RoomParticipant[] {
  return getAgentParticipants(room).filter((participant) => participant.enabled);
}

function getHumanParticipants(room: RoomSession): RoomParticipant[] {
  return room.participants.filter((participant) => participant.runtimeKind === "human");
}

function getParticipantSender(participant: RoomParticipant): RoomSender {
  return {
    id: participant.id,
    name: participant.name,
    role: participant.senderRole,
  };
}

function getPrimaryRoomAgentId(room: RoomSession): RoomAgentId {
  return getEnabledAgentParticipants(room)[0]?.agentId ?? room.agentId;
}

function createSchedulerState(agentParticipantId: string | null): RoomSchedulerState {
  return {
    status: "idle",
    nextAgentParticipantId: agentParticipantId,
    activeParticipantId: null,
    roundCount: 0,
    agentCursorByParticipantId: {},
    agentReceiptRevisionByParticipantId: {},
  };
}

function createRoomSession(index: number, agentId: RoomAgentId = DEFAULT_AGENT_ID): RoomSession {
  const timestamp = createTimestamp();
  const participants = sortRoomParticipants([createHumanParticipant(LOCAL_PARTICIPANT_SENDER.name), createAgentParticipant(agentId, 1)]);
  return {
    id: crypto.randomUUID(),
    title: getRoomIndexTitle(index),
    agentId,
    archivedAt: null,
    ownerParticipantId: DEFAULT_LOCAL_PARTICIPANT_ID,
    receiptRevision: 0,
    participants,
    scheduler: createSchedulerState(agentId),
    roomMessages: [],
    agentTurns: [],
    error: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function getNextRoomMessageSeq(room: RoomSession): number {
  return (room.roomMessages[room.roomMessages.length - 1]?.seq ?? 0) + 1;
}

function createRoomMessage(
  roomId: string,
  role: RoomMessage["role"],
  content: string,
  source: RoomMessage["source"],
  options?: Partial<Pick<RoomMessage, "kind" | "status" | "final" | "sender" | "seq">>,
): RoomMessage {
  const defaultKind = role === "user" ? "user_input" : role === "system" ? "system" : "answer";
  const defaultSender =
    role === "system" || source === "system"
      ? SYSTEM_SENDER
      : role === "assistant" || source === "agent_emit"
        ? GENERIC_AGENT_SENDER
        : LOCAL_PARTICIPANT_SENDER;

  return {
    id: crypto.randomUUID(),
    roomId,
    seq: options?.seq ?? 0,
    role,
    sender: options?.sender || defaultSender,
    content,
    source,
    kind: options?.kind || defaultKind,
    status: options?.status || "completed",
    final: options?.final ?? true,
    createdAt: createTimestamp(),
    receipts: [],
    receiptStatus: "none",
    receiptUpdatedAt: null,
  };
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
    ...(value.agentId === "concierge" || value.agentId === "researcher" || value.agentId === "operator"
      ? {
          agentId: value.agentId,
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

function normalizeRoomAgentId(value: unknown): RoomAgentId {
  if (value === "concierge" || value === "researcher" || value === "operator") {
    return value;
  }

  return DEFAULT_AGENT_ID;
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
      roomId: typeof value.roomId === "string" ? value.roomId : crypto.randomUUID(),
      title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : "New Room",
      agentIds: Array.isArray(value.agentIds)
        ? value.agentIds.filter((agentId): agentId is RoomAgentId => agentId === "concierge" || agentId === "researcher" || agentId === "operator")
        : [],
    };
  }

  if (value.type === "add_agents_to_room") {
    return {
      type: "add_agents_to_room",
      roomId: typeof value.roomId === "string" ? value.roomId : "",
      agentIds: Array.isArray(value.agentIds)
        ? value.agentIds.filter((agentId): agentId is RoomAgentId => agentId === "concierge" || agentId === "researcher" || agentId === "operator")
        : [],
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

function normalizeRoomMessage(
  value: unknown,
  fallbackRole: RoomMessage["role"] = "assistant",
  fallbackSource: RoomMessage["source"] = "agent_emit",
): RoomMessage | null {
  if (!isRecord(value) || typeof value.content !== "string") {
    return null;
  }

  const content = value.content.trim();
  if (!content) {
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
    id: typeof value.id === "string" && value.id ? value.id : crypto.randomUUID(),
    roomId: typeof value.roomId === "string" && value.roomId ? value.roomId : "",
    seq: typeof value.seq === "number" && Number.isFinite(value.seq) && value.seq > 0 ? Math.round(value.seq) : 0,
    role,
    sender: normalizeRoomSender(value.sender, role, source),
    content,
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

  return {
    id: typeof value.id === "string" && value.id ? value.id : crypto.randomUUID(),
    sequence: typeof value.sequence === "number" && value.sequence > 0 ? value.sequence : index + 1,
    toolName: typeof value.toolName === "string" && value.toolName ? value.toolName : "tool",
    displayName: typeof value.displayName === "string" && value.displayName ? value.displayName : "Tool",
    inputSummary: typeof value.inputSummary === "string" ? value.inputSummary : inputText,
    inputText,
    resultPreview: typeof value.resultPreview === "string" ? value.resultPreview : outputText,
    outputText,
    status: value.status === "error" ? "error" : "success",
    durationMs: typeof value.durationMs === "number" && value.durationMs >= 0 ? value.durationMs : 0,
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

  return {
    id: typeof value.id === "string" && value.id ? value.id : crypto.randomUUID(),
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
    assistantContent: typeof value.assistantContent === "string" ? value.assistantContent : "",
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
    maxToolLoopSteps: coerceMaxToolLoopSteps(value.maxToolLoopSteps),
    thinkingLevel: coerceThinkingLevel(value.thinkingLevel),
    enabledSkillIds: coerceSkillIds(value.enabledSkillIds),
  };
}

function normalizeRoomSession(value: unknown, index: number): RoomSession | null {
  if (!isRecord(value)) {
    return null;
  }

  const agentId = normalizeRoomAgentId(value.agentId);
  const roomId = typeof value.id === "string" && value.id ? value.id : crypto.randomUUID();
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
    agentTurns,
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
    agentTurns,
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
    let agentStates = createInitialAgentStates();
    for (const agent of ROOM_AGENTS) {
      agentStates[agent.id] = normalizeAgentSharedState(agent.id, parsedAgentStates[agent.id]);
    }

    for (const room of Array.isArray(parsed.rooms) ? parsed.rooms : []) {
      agentStates = mergeLegacyRoomStateIntoAgentStates(agentStates, room);
    }

    const activeRoomId =
      typeof parsed.activeRoomId === "string" && rooms.some((room) => room.id === parsed.activeRoomId)
        ? parsed.activeRoomId
        : rooms[0].id;
    const selectedConsoleAgentId =
      parsed.selectedConsoleAgentId === "concierge" || parsed.selectedConsoleAgentId === "researcher" || parsed.selectedConsoleAgentId === "operator"
        ? parsed.selectedConsoleAgentId
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

function extractNextBlock(buffer: string): { block: string; rest: string } | null {
  const separatorMatch = buffer.match(/\r?\n\r?\n/);
  if (!separatorMatch || separatorMatch.index === undefined) {
    return null;
  }

  return {
    block: buffer.slice(0, separatorMatch.index),
    rest: buffer.slice(separatorMatch.index + separatorMatch[0].length),
  };
}

function parseRoomStreamBlock(block: string): RoomChatStreamEvent | null {
  const dataLines = block
    .split(/\r?\n/g)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return null;
  }

  try {
    return JSON.parse(dataLines.join("\n")) as RoomChatStreamEvent;
  } catch {
    return null;
  }
}

function updateTurn(
  turns: AgentRoomTurn[],
  turnId: string,
  updater: (turn: AgentRoomTurn) => AgentRoomTurn,
): AgentRoomTurn[] {
  return turns.map((turn) => (turn.id === turnId ? updater(turn) : turn));
}

function updateRoomMessage(
  messages: RoomMessage[],
  messageId: string,
  updater: (message: RoomMessage) => RoomMessage,
): RoomMessage[] {
  return messages.map((message) => (message.id === messageId ? updater(message) : message));
}

function appendMessageToRoom(room: RoomSession, message: RoomMessage): RoomSession {
  const nextSeq = getNextRoomMessageSeq(room);
  const nextMessages = [...room.roomMessages, { ...message, roomId: room.id, seq: nextSeq }];
  return {
    ...room,
    roomMessages: nextMessages,
    updatedAt: createTimestamp(),
  };
}

function syncRoomParticipants(room: RoomSession, participants: RoomParticipant[]): RoomSession {
  const nextParticipants = sortRoomParticipants(participants);
  const enabledAgents = nextParticipants.filter((participant) => participant.runtimeKind === "agent" && participant.enabled);
  const nextOwnerParticipantId = pickRoomOwnerParticipantId(nextParticipants, room.ownerParticipantId);
  const nextActiveParticipantId =
    room.scheduler.activeParticipantId && nextParticipants.some((participant) => participant.id === room.scheduler.activeParticipantId)
      ? room.scheduler.activeParticipantId
      : null;
  const nextAgentCursorByParticipantId = Object.fromEntries(
    Object.entries(room.scheduler.agentCursorByParticipantId).filter(([participantId]) =>
      nextParticipants.some((participant) => participant.id === participantId && participant.runtimeKind === "agent"),
    ),
  ) as Record<string, number>;
  const nextAgentReceiptRevisionByParticipantId = Object.fromEntries(
    Object.entries(room.scheduler.agentReceiptRevisionByParticipantId).filter(([participantId]) =>
      nextParticipants.some((participant) => participant.id === participantId && participant.runtimeKind === "agent"),
    ),
  ) as Record<string, number>;

  return {
    ...room,
    agentId: enabledAgents[0]?.agentId ?? room.agentId,
    ownerParticipantId: nextOwnerParticipantId,
    participants: nextParticipants,
    scheduler: {
      ...room.scheduler,
      nextAgentParticipantId:
        room.scheduler.nextAgentParticipantId && enabledAgents.some((participant) => participant.id === room.scheduler.nextAgentParticipantId)
          ? room.scheduler.nextAgentParticipantId
          : enabledAgents[0]?.id ?? null,
      activeParticipantId: nextActiveParticipantId,
      agentCursorByParticipantId: nextAgentCursorByParticipantId,
      agentReceiptRevisionByParticipantId: nextAgentReceiptRevisionByParticipantId,
    },
    updatedAt: createTimestamp(),
  };
}

function applyMessageReceiptUpdate(messages: RoomMessage[], update: RoomMessageReceiptUpdate): RoomMessage[] {
  return updateRoomMessage(messages, update.messageId, (message) => {
    const receipts = upsertRoomMessageReceipt(message.receipts, update.receipt);
    return {
      ...message,
      receipts,
      receiptStatus: getReceiptStatus(receipts),
      receiptUpdatedAt: getReceiptUpdatedAt(receipts),
    };
  });
}

function getNextAgentParticipant(room: RoomSession, currentParticipantId?: string | null): RoomParticipant | null {
  const enabledAgents = getEnabledAgentParticipants(room);
  if (enabledAgents.length === 0) {
    return null;
  }

  if (currentParticipantId) {
    const currentIndex = enabledAgents.findIndex((participant) => participant.id === currentParticipantId);
    if (currentIndex >= 0) {
      return enabledAgents[(currentIndex + 1) % enabledAgents.length];
    }
  }

  if (room.scheduler.nextAgentParticipantId) {
    const scheduled = enabledAgents.find((participant) => participant.id === room.scheduler.nextAgentParticipantId);
    if (scheduled) {
      return scheduled;
    }
  }

  return enabledAgents[0];
}

function getSchedulerVisibleTargetMessages(messages: RoomMessage[], participant: RoomParticipant): RoomMessage[] {
  return messages.filter((message) => message.sender.role === "participant" && message.sender.id !== participant.id);
}

function buildSchedulerPacketContent(
  room: RoomSession,
  participant: RoomParticipant,
  messages: RoomMessage[],
  options?: {
    hasNewDelta?: boolean;
  },
): string {
  const visibleTargetMessages = getSchedulerVisibleTargetMessages(messages, participant);
  const latestParticipantMessage = visibleTargetMessages[visibleTargetMessages.length - 1] ?? null;

  return [
    "[Room scheduler sync packet]",
    `Target participant: ${participant.name} (${participant.id})`,
    "This packet contains the room messages you have not consumed yet.",
    "Important: this scheduler packet is a system transport note. If you use room tools, target the participant message ids listed below, not this packet id.",
    options?.hasNewDelta
      ? "Use the current receipt markers to understand which participants already chose read_no_reply."
      : "No new room message seq arrived since your last turn.",
    latestParticipantMessage
      ? `Latest unseen participant message: seq ${latestParticipantMessage.seq}, messageId ${latestParticipantMessage.id}, from ${latestParticipantMessage.sender.name} (${latestParticipantMessage.sender.id})`
      : "Latest unseen participant message: none",
    "If the latest unseen participant message is clearly asking for your input, naming you, or continuing a live multi-agent exchange, prefer a visible room message instead of read_no_reply.",
    "Only use read_no_reply when the newest unseen participant message truly needs no visible response.",
    "Messages:",
    ...messages.map((message) => {
      const receiptSummary = formatReceiptSummary(message.receipts);
      return `- seq ${message.seq} | messageId ${message.id} | ${message.sender.name} (${message.sender.id}, ${message.sender.role}) | ${message.kind}/${message.status}${receiptSummary ? ` | receipts: ${receiptSummary}` : ""}: ${message.content}`;
    }),
  ].join("\n");
}

function getActiveRooms(rooms: RoomSession[]): RoomSession[] {
  return rooms.filter((room) => !room.archivedAt);
}

function getArchivedRooms(rooms: RoomSession[]): RoomSession[] {
  return rooms.filter((room) => Boolean(room.archivedAt));
}

function getNextRoomIndex(rooms: RoomSession[]): number {
  return rooms.length + 1;
}

function getRoomPreview(room: RoomSession): string {
  const lastMessage = room.roomMessages[room.roomMessages.length - 1];
  if (!lastMessage) {
    return room.archivedAt ? "Archived room" : "Empty room";
  }

  const preview = lastMessage.content.replace(/\s+/g, " ").trim();
  return preview.length > 56 ? `${preview.slice(0, 56).trim()}...` : preview;
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

function getRoomOwnerLabel(room: RoomSession): string {
  return getRoomOwnerParticipant(room)?.name ?? "none";
}

function createRoomParticipantSnapshot(room: RoomSession, participant: RoomParticipant) {
  return {
    participantId: participant.id,
    name: participant.name,
    runtimeKind: participant.runtimeKind,
    membershipRole: getParticipantMembershipRole(room, participant.id),
    enabled: participant.enabled,
    ...(participant.agentId
      ? {
          agentId: participant.agentId,
        }
      : {}),
  };
}

function createAttachedRoomDefinition(room: RoomSession, currentAgentId?: RoomAgentId): AttachedRoomDefinition {
  const currentAgentParticipant = currentAgentId
    ? room.participants.find((participant) => participant.runtimeKind === "agent" && participant.agentId === currentAgentId)
    : null;

  return {
    id: room.id,
    title: room.title,
    archived: Boolean(room.archivedAt),
    ownerParticipantId: room.ownerParticipantId,
    ownerName: getRoomOwnerLabel(room),
    currentAgentMembershipRole: currentAgentParticipant ? getParticipantMembershipRole(room, currentAgentParticipant.id) : null,
    currentAgentIsOwner: Boolean(currentAgentParticipant && room.ownerParticipantId === currentAgentParticipant.id),
    participants: room.participants.map((participant) => createRoomParticipantSnapshot(room, participant)),
    messageCount: room.roomMessages.length,
    latestMessageAt: room.roomMessages[room.roomMessages.length - 1]?.createdAt ?? null,
  };
}

function createAgentInfoCard(agent: RoomAgentDefinition): AgentInfoCard {
  return {
    agentId: agent.id,
    label: agent.label,
    summary: agent.summary,
    skills: [...agent.skills],
    workingStyle: agent.workingStyle,
  };
}

function createRoomHistorySummary(room: RoomSession): RoomHistoryMessageSummary[] {
  return room.roomMessages.map((message) => ({
    messageId: message.id,
    seq: message.seq,
    senderId: message.sender.id,
    senderName: message.sender.name,
    senderRole: message.sender.role,
    role: message.role,
    source: message.source,
    kind: message.kind,
    status: message.status,
    final: message.final,
    createdAt: message.createdAt,
    content: message.content,
    receipts: message.receipts.map((receipt) => ({
      ...receipt,
    })),
  }));
}

function createSystemRoomEvent(room: RoomSession, content: string): RoomMessage {
  return createRoomMessage(room.id, "system", content, "system", {
    seq: getNextRoomMessageSeq(room),
    sender: SYSTEM_SENDER,
    kind: "system",
    status: "completed",
    final: true,
  });
}

function createAgentOwnedRoomSession(roomId: string, title: string, ownerAgentId: RoomAgentId, agentIds: RoomAgentId[]): RoomSession {
  const timestamp = createTimestamp();
  const uniqueAgentIds = [...new Set(agentIds.length > 0 ? agentIds : [ownerAgentId])];
  const participants = sortRoomParticipants(uniqueAgentIds.map((agentId, index) => createAgentParticipant(agentId, index + 1)));
  let room: RoomSession = {
    id: roomId,
    title,
    agentId: ownerAgentId,
    archivedAt: null,
    ownerParticipantId: ownerAgentId,
    receiptRevision: 0,
    participants,
    scheduler: createSchedulerState(ownerAgentId),
    roomMessages: [],
    agentTurns: [],
    error: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const memberNames = participants.map((participant) => participant.name).join(", ");
  room = appendMessageToRoom(room, createSystemRoomEvent(room, `${getRoomAgent(ownerAgentId).label} created this room with ${memberNames}.`));
  return room;
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

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "recently";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [rooms, setRooms] = useState<RoomSession[]>([]);
  const [agentStates, setAgentStates] = useState<Record<RoomAgentId, AgentSharedState>>(createInitialAgentStates());
  const [activeRoomId, setActiveRoomId] = useState("");
  const [selectedConsoleAgentId, setSelectedConsoleAgentId] = useState<RoomAgentId | null>(null);
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const [selectedSenderByRoomId, setSelectedSenderByRoomId] = useState<Record<string, string>>({});
  const [draftsByRoomId, setDraftsByRoomId] = useState<Record<string, string>>({});
  const [runningAgentRequestIds, setRunningAgentRequestIds] = useState<Record<string, string>>({});
  const [resettingAgentContextIds, setResettingAgentContextIds] = useState<Record<string, boolean>>({});
  const [compactingAgentContextIds, setCompactingAgentContextIds] = useState<Record<string, boolean>>({});
  const [hydrated, setHydrated] = useState(false);
  const activeRunsRef = useRef<Record<string, ActiveRoomRun>>({});
  const activeSchedulerRunsRef = useRef<Record<string, ActiveSchedulerRun>>({});
  const roomsRef = useRef<RoomSession[]>([]);
  const agentStatesRef = useRef<Record<RoomAgentId, AgentSharedState>>(createInitialAgentStates());
  const workspaceVersionRef = useRef(0);
  const skipNextServerPersistRef = useRef(false);
  const workspacePersistTimerRef = useRef<number | null>(null);
  const pendingWorkspacePersistRef = useRef<RoomWorkspaceState | null>(null);
  const workspacePersistInFlightRef = useRef(false);
  const workspacePersistNonceRef = useRef(0);
  const runRoomSchedulerRef = useRef<(roomId: string) => Promise<void>>(async () => undefined);

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
      const nextRooms = snapshot.rooms.length > 0 ? snapshot.rooms : [createRoomSession(1)];
      const nextAgentStates = snapshot.agentStates;
      const nextActiveRoomId =
        snapshot.activeRoomId && nextRooms.some((room) => room.id === snapshot.activeRoomId)
          ? snapshot.activeRoomId
          : nextRooms[0]?.id ?? "";
      const nextSelectedConsoleAgentId = snapshot.selectedConsoleAgentId ?? getPrimaryRoomAgentId(nextRooms[0]);

      roomsRef.current = nextRooms;
      agentStatesRef.current = nextAgentStates;
      workspaceVersionRef.current = version;
      setRooms(nextRooms);
      setAgentStates(nextAgentStates);
      setActiveRoomId(nextActiveRoomId);
      setSelectedConsoleAgentId(nextSelectedConsoleAgentId);
      setWorkspaceVersion(version);
      setHydrated(true);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    const loadLocalWorkspace = (): RoomWorkspaceState | null => {
      try {
        const persisted = localStorage.getItem(STORAGE_KEY);
        const parsedWorkspace = persisted ? parseWorkspaceState(persisted) : null;
        if (parsedWorkspace) {
          return parsedWorkspace;
        }

        const previousPersisted = localStorage.getItem(PREVIOUS_STORAGE_KEY);
        const previousWorkspace = previousPersisted ? parseWorkspaceState(previousPersisted) : null;
        if (previousWorkspace) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(previousWorkspace));
          localStorage.removeItem(PREVIOUS_STORAGE_KEY);
          return previousWorkspace;
        }

        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        const migratedWorkspace = legacy ? migrateLegacyWorkspaceState(legacy) : null;
        if (migratedWorkspace) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(migratedWorkspace));
          localStorage.removeItem(LEGACY_STORAGE_KEY);
          return migratedWorkspace;
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(PREVIOUS_STORAGE_KEY);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }

      return null;
    };

    void (async () => {
      const response = await fetch("/api/workspace", { cache: "no-store" }).catch(() => null);
      const serverEnvelope = response?.ok
        ? ((await response.json().catch(() => null)) as { version?: number; state?: RoomWorkspaceState } | null)
        : null;
      const serverVersion = typeof serverEnvelope?.version === "number" ? serverEnvelope.version : 0;
      const serverState = serverEnvelope?.state ?? null;
      const localWorkspace = loadLocalWorkspace();

      if (cancelled) {
        return;
      }

      if (serverState && serverVersion > 0) {
        applyWorkspaceSnapshot(serverState, serverVersion, { skipServerPersist: true });
        return;
      }

      if (localWorkspace) {
        applyWorkspaceSnapshot(localWorkspace, serverVersion, { skipServerPersist: false });
        return;
      }

      if (serverState) {
        applyWorkspaceSnapshot(serverState, serverVersion, { skipServerPersist: true });
        return;
      }

      const initialRoom = createRoomSession(1);
      const initialAgentStates = createInitialAgentStates();
      applyWorkspaceSnapshot(
        {
          rooms: [initialRoom],
          agentStates: initialAgentStates,
          activeRoomId: initialRoom.id,
          selectedConsoleAgentId: initialRoom.agentId,
        },
        0,
        { skipServerPersist: false },
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [applyWorkspaceSnapshot]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    const availableRooms = getActiveRooms(rooms);
    if (availableRooms.length === 0) {
      const fallbackRoom = createRoomSession(getNextRoomIndex(roomsRef.current));
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

  useEffect(() => {
    if (!hydrated || rooms.length === 0 || !activeRoomId) {
      return;
    }

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        rooms,
        agentStates,
        activeRoomId,
        selectedConsoleAgentId: selectedConsoleAgentId ?? undefined,
      } satisfies RoomWorkspaceState),
    );
  }, [activeRoomId, agentStates, hydrated, rooms, selectedConsoleAgentId]);

  useEffect(() => {
    workspaceVersionRef.current = workspaceVersion;
  }, [workspaceVersion]);

  const persistWorkspaceSnapshot = useCallback(async () => {
    if (workspacePersistInFlightRef.current) {
      return;
    }

    workspacePersistInFlightRef.current = true;
    let scheduledDelayedRetry = false;
    try {
      while (pendingWorkspacePersistRef.current) {
        const payload = pendingWorkspacePersistRef.current;
        const requestNonce = workspacePersistNonceRef.current;
        pendingWorkspacePersistRef.current = null;

        const response = await fetch("/api/workspace", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            expectedVersion: workspaceVersionRef.current,
            state: payload,
          }),
        }).catch(() => null);

        if (!response) {
          pendingWorkspacePersistRef.current = pendingWorkspacePersistRef.current ?? payload;
          window.setTimeout(() => {
            void persistWorkspaceSnapshot();
          }, 1000);
          scheduledDelayedRetry = true;
          break;
        }

        if (response.ok) {
          const nextEnvelope = (await response.json().catch(() => null)) as { version?: number } | null;
          if (typeof nextEnvelope?.version === "number") {
            workspaceVersionRef.current = nextEnvelope.version;
            setWorkspaceVersion(nextEnvelope.version);
          }
          continue;
        }

        if (response.status !== 409) {
          continue;
        }

        const conflictPayload = (await response.json().catch(() => null)) as {
          envelope?: { version?: number; state?: RoomWorkspaceState };
        } | null;
        const conflictVersion = conflictPayload?.envelope?.version;
        const conflictState = conflictPayload?.envelope?.state;

        if (typeof conflictVersion === "number") {
          workspaceVersionRef.current = conflictVersion;
          setWorkspaceVersion(conflictVersion);
        }

        const requestIsLatest = requestNonce === workspacePersistNonceRef.current && pendingWorkspacePersistRef.current === null;
        if (requestIsLatest && typeof conflictVersion === "number" && conflictState && Object.keys(activeRunsRef.current).length === 0) {
          applyWorkspaceSnapshot(conflictState, conflictVersion, {
            skipServerPersist: true,
          });
          break;
        }

        pendingWorkspacePersistRef.current = pendingWorkspacePersistRef.current ?? payload;
      }
    } finally {
      workspacePersistInFlightRef.current = false;
      if (pendingWorkspacePersistRef.current && !scheduledDelayedRetry) {
        void persistWorkspaceSnapshot();
      }
    }
  }, [applyWorkspaceSnapshot]);

  useEffect(() => {
    if (!hydrated || rooms.length === 0 || !activeRoomId) {
      return;
    }

    if (skipNextServerPersistRef.current) {
      skipNextServerPersistRef.current = false;
      return;
    }

    const payload = {
      rooms,
      agentStates,
      activeRoomId,
      selectedConsoleAgentId: selectedConsoleAgentId ?? undefined,
    } satisfies RoomWorkspaceState;

    const timer = window.setTimeout(() => {
      workspacePersistNonceRef.current += 1;
      pendingWorkspacePersistRef.current = payload;
      void persistWorkspaceSnapshot();
    }, 400);
    workspacePersistTimerRef.current = timer;

    return () => {
      window.clearTimeout(timer);
      if (workspacePersistTimerRef.current === timer) {
        workspacePersistTimerRef.current = null;
      }
    };
  }, [activeRoomId, agentStates, hydrated, persistWorkspaceSnapshot, rooms, selectedConsoleAgentId]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    const interval = setInterval(() => {
      if (Object.keys(activeRunsRef.current).length > 0) {
        return;
      }

      void (async () => {
        const response = await fetch("/api/workspace", { cache: "no-store" }).catch(() => null);
        if (!response?.ok) {
          return;
        }

        const payload = (await response.json().catch(() => null)) as { version?: number; state?: RoomWorkspaceState } | null;
        if (
          typeof payload?.version === "number"
          && payload.version > workspaceVersionRef.current
          && payload.state
        ) {
          applyWorkspaceSnapshot(payload.state, payload.version, { skipServerPersist: true });
        }
      })();
    }, 15_000);

    return () => {
      clearInterval(interval);
    };
  }, [applyWorkspaceSnapshot, hydrated]);

  useEffect(
    () => () => {
      Object.values(activeRunsRef.current).forEach((run) => run.controller.abort());
      activeRunsRef.current = {};
      activeSchedulerRunsRef.current = {};
    },
    [],
  );

  useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);

  useEffect(() => {
    agentStatesRef.current = agentStates;
  }, [agentStates]);

  const replaceRooms = useCallback((nextRooms: RoomSession[]) => {
    roomsRef.current = nextRooms;
    setRooms(nextRooms);
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    const staleRunningRoomIds = roomsRef.current
      .filter((room) => room.scheduler.status === "running" && !activeSchedulerRunsRef.current[room.id])
      .map((room) => room.id);

    if (staleRunningRoomIds.length === 0) {
      return;
    }

    const staleRunningRoomIdSet = new Set(staleRunningRoomIds);
    replaceRooms(
      sortRoomsByUpdatedAt(
        roomsRef.current.map((room) =>
          staleRunningRoomIdSet.has(room.id)
            ? {
                ...room,
                scheduler: {
                  ...room.scheduler,
                  status: "idle",
                  activeParticipantId: null,
                  roundCount: 0,
                },
                updatedAt: createTimestamp(),
              }
            : room,
        ),
      ),
    );
  }, [hydrated, replaceRooms, rooms]);

  const updateRoomState = useCallback(
    (roomId: string, updater: (room: RoomSession) => RoomSession) => {
      replaceRooms(sortRoomsByUpdatedAt(roomsRef.current.map((room) => (room.id === roomId ? updater(room) : room))));
    },
    [replaceRooms],
  );

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

  const updateAgentTurns = useCallback(
    (agentId: RoomAgentId, updater: (turns: AgentRoomTurn[]) => AgentRoomTurn[]) => {
      updateAgentState(agentId, (state) => ({
        ...state,
        agentTurns: sortAgentTurnsByUserMessageTime(updater(state.agentTurns)),
        updatedAt: createTimestamp(),
      }));
    },
    [updateAgentState],
  );

  const applyReceiptUpdateToTurns = useCallback((turns: AgentRoomTurn[], update: RoomMessageReceiptUpdate): AgentRoomTurn[] => {
    let changed = false;
    const nextTurns = turns.map((turn) => {
      if (turn.userMessage.id !== update.messageId) {
        return turn;
      }

      const receipts = upsertRoomMessageReceipt(turn.userMessage.receipts, update.receipt);
      changed = true;
      return {
        ...turn,
        userMessage: {
          ...turn.userMessage,
          receipts,
          receiptStatus: getReceiptStatus(receipts),
          receiptUpdatedAt: getReceiptUpdatedAt(receipts),
        },
      };
    });

    return changed ? nextTurns : turns;
  }, []);

  const applyReceiptUpdateToAllAgentConsoles = useCallback(
    (update: RoomMessageReceiptUpdate) => {
      setAgentStates((current) => {
        let changed = false;
        const nextState = { ...current };

        for (const agentId of Object.keys(current) as RoomAgentId[]) {
          const state = current[agentId];
          const nextTurns = applyReceiptUpdateToTurns(state.agentTurns, update);
          if (nextTurns === state.agentTurns) {
            continue;
          }

          changed = true;
          nextState[agentId] = {
            ...state,
            agentTurns: sortAgentTurnsByUserMessageTime(nextTurns),
            updatedAt: createTimestamp(),
          };
        }

        if (changed) {
          agentStatesRef.current = nextState;
          return nextState;
        }

        return current;
      });
    },
    [applyReceiptUpdateToTurns],
  );

  const reduceRoomManagementActions = useCallback(
    (currentRooms: RoomSession[], actions: RoomToolActionUnion[], actorAgentId: RoomAgentId): RoomSession[] => {
      let nextRooms = currentRooms;

      for (const action of actions) {
        if (action.type === "read_no_reply") {
          continue;
        }

        if (action.type === "create_room") {
          if (nextRooms.some((room) => room.id === action.roomId)) {
            continue;
          }

          const nextRoom = createAgentOwnedRoomSession(action.roomId, action.title, actorAgentId, action.agentIds);
          nextRooms = [nextRoom, ...nextRooms];
          continue;
        }

        if (action.type === "add_agents_to_room") {
          nextRooms = nextRooms.map((room) => {
            if (room.id !== action.roomId || room.archivedAt) {
              return room;
            }

            const existingAgentIds = new Set(getAgentParticipants(room).flatMap((participant) => (participant.agentId ? [participant.agentId] : [])));
            const additions = action.agentIds.filter((agentId) => !existingAgentIds.has(agentId));
            if (additions.length === 0) {
              return room;
            }

            let nextRoom = syncRoomParticipants(
              room,
              [
                ...room.participants,
                ...additions.map((agentId, index) => createAgentParticipant(agentId, getAgentParticipants(room).length + index + 1)),
              ],
            );
            nextRoom = appendMessageToRoom(
              nextRoom,
              createSystemRoomEvent(nextRoom, `${getRoomAgent(actorAgentId).label} added ${additions.map((agentId) => getRoomAgent(agentId).label).join(", ")} to the room.`),
            );
            return nextRoom;
          });
          continue;
        }

        if (action.type === "leave_room") {
          nextRooms = nextRooms.map((room) => {
            if (room.id !== action.roomId || room.archivedAt || !room.participants.some((participant) => participant.id === actorAgentId)) {
              return room;
            }

            let nextRoom = syncRoomParticipants(
              room,
              room.participants.filter((participant) => participant.id !== actorAgentId),
            );
            nextRoom = appendMessageToRoom(nextRoom, createSystemRoomEvent(nextRoom, `${getRoomAgent(actorAgentId).label} left the room.`));
            return nextRoom;
          });
          continue;
        }

        if (action.type === "remove_room_participant") {
          nextRooms = nextRooms.map((room) => {
            if (room.id !== action.roomId || room.archivedAt) {
              return room;
            }

            const removedParticipant = room.participants.find((participant) => participant.id === action.participantId);
            if (!removedParticipant) {
              return room;
            }

            let nextRoom = syncRoomParticipants(
              room,
              room.participants.filter((participant) => participant.id !== action.participantId),
            );
            nextRoom = appendMessageToRoom(
              nextRoom,
              createSystemRoomEvent(nextRoom, `${getRoomAgent(actorAgentId).label} removed ${removedParticipant.name} from the room.`),
            );
            return nextRoom;
          });
        }
      }

      return nextRooms;
    },
    [],
  );

  const applyRoomToolActions = useCallback(
    (actions: RoomToolActionUnion[], actorAgentId: RoomAgentId) => {
      if (actions.length === 0) {
        return;
      }

      const nextRooms = reduceRoomManagementActions(roomsRef.current, actions, actorAgentId);
      if (nextRooms === roomsRef.current) {
        return;
      }

      replaceRooms(sortRoomsByUpdatedAt(nextRooms));
    },
    [reduceRoomManagementActions, replaceRooms],
  );

  const applyRoomToolAction = useCallback(
    (action: RoomToolActionUnion, actorAgentId: RoomAgentId) => {
      applyRoomToolActions([action], actorAgentId);
    },
    [applyRoomToolActions],
  );

  const getActiveAgentRun = useCallback((agentId: RoomAgentId): ActiveRoomRun | null => {
    return activeRunsRef.current[agentId] ?? null;
  }, []);

  const isCurrentAgentRun = useCallback((agentId: RoomAgentId, requestId: string): boolean => {
    return activeRunsRef.current[agentId]?.requestId === requestId;
  }, []);

  const startAgentRun = useCallback((agentId: RoomAgentId, run: ActiveRoomRun) => {
    activeRunsRef.current[agentId] = run;
    setRunningAgentRequestIds((current) => ({
      ...current,
      [agentId]: run.requestId,
    }));
  }, []);

  const finishAgentRun = useCallback(
    (agentId: RoomAgentId, requestId: string) => {
      if (!isCurrentAgentRun(agentId, requestId)) {
        return;
      }

      delete activeRunsRef.current[agentId];
      setRunningAgentRequestIds((current) => {
        const nextState = { ...current };
        delete nextState[agentId];
        return nextState;
      });
    },
    [isCurrentAgentRun],
  );

  const roomHasRunningAgent = useCallback((room: RoomSession): boolean => {
    return room.scheduler.status === "running" || Boolean(activeSchedulerRunsRef.current[room.id]?.activeAgentId);
  }, []);

  const shouldAutoRestartSchedulerForMessage = useCallback(
    (room: RoomSession, message: RoomMessage): boolean => {
      if (room.archivedAt) {
        return false;
      }

      if (room.scheduler.status === "running" || activeSchedulerRunsRef.current[room.id]?.activeAgentId) {
        return false;
      }

      if (message.sender.role !== "participant") {
        return false;
      }

      return getEnabledAgentParticipants(room).some((participant) => participant.id !== message.sender.id);
    },
    [],
  );

  const interruptRoomScheduler = useCallback(
    (roomId: string) => {
      const activeSchedulerRun = activeSchedulerRunsRef.current[roomId];
      if (activeSchedulerRun?.activeAgentId && activeSchedulerRun.activeRequestId) {
        const activeRun = activeRunsRef.current[activeSchedulerRun.activeAgentId];
        if (activeRun && activeRun.requestId === activeSchedulerRun.activeRequestId) {
          activeRun.controller.abort(new Error("Superseded by a newer room message."));
        }
      }

      activeSchedulerRunsRef.current[roomId] = {
        cycleId: crypto.randomUUID(),
        activeAgentId: null,
        activeRequestId: null,
      };

      updateRoomState(roomId, (room) => ({
        ...room,
        scheduler: {
          ...room.scheduler,
          status: "idle",
          activeParticipantId: null,
          roundCount: 0,
        },
        error: "",
        updatedAt: createTimestamp(),
      }));
    },
    [updateRoomState],
  );

  const maybeStartSchedulerForRoomMessage = useCallback(
    (roomId: string, message: RoomMessage) => {
      const room = roomsRef.current.find((candidate) => candidate.id === roomId);
      if (!room || !shouldAutoRestartSchedulerForMessage(room, message)) {
        return;
      }

      void runRoomSchedulerRef.current(roomId);
    },
    [shouldAutoRestartSchedulerForMessage],
  );

  const getAttachedRoomsForAgent = useCallback((agentId: RoomAgentId, currentRoomId: string, currentRoomTitle: string) => {
    return getActiveRooms(roomsRef.current)
      .filter((room) => room.participants.some((participant) => participant.runtimeKind === "agent" && participant.agentId === agentId))
      .map((room) => {
        const attachedRoom = createAttachedRoomDefinition(room, agentId);
        return room.id === currentRoomId
          ? {
              ...attachedRoom,
              title: currentRoomTitle,
            }
          : attachedRoom;
      });
  }, []);

  const getKnownAgentsForToolContext = useCallback((): AgentInfoCard[] => {
    return ROOM_AGENTS.map((agent) => createAgentInfoCard(agent));
  }, []);

  const getRoomHistoryByIdForAgent = useCallback((agentId: RoomAgentId): Record<string, RoomHistoryMessageSummary[]> => {
    return Object.fromEntries(
      getActiveRooms(roomsRef.current)
        .filter((room) => room.participants.some((participant) => participant.runtimeKind === "agent" && participant.agentId === agentId))
        .map((room) => [room.id, createRoomHistorySummary(room)]),
    );
  }, []);

  const readRoomStream = useCallback(
    async (
      response: Response,
      initiatingRoomId: string,
      agentId: RoomAgentId,
      turnId: string,
      requestId: string,
    ): Promise<{
      emittedMessages: RoomMessage[];
      receiptUpdates: RoomMessageReceiptUpdate[];
    }> => {
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("The room stream did not contain a readable body.");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      const emittedMessages: RoomMessage[] = [];
      const receiptUpdates: RoomMessageReceiptUpdate[] = [];

      while (true) {
        const { value, done } = await reader.read();

        if (!isCurrentAgentRun(agentId, requestId)) {
          await reader.cancel().catch(() => undefined);
          return {
            emittedMessages,
            receiptUpdates,
          };
        }

        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

        while (true) {
          const nextBlock = extractNextBlock(buffer);
          if (!nextBlock) {
            break;
          }

          buffer = nextBlock.rest;
          const event = parseRoomStreamBlock(nextBlock.block);
          if (!event) {
            continue;
          }

          if (!isCurrentAgentRun(agentId, requestId)) {
            await reader.cancel().catch(() => undefined);
            return {
              emittedMessages,
              receiptUpdates,
            };
          }

          if (event.type === "agent-text-delta") {
            updateAgentTurns(agentId, (turns) =>
              updateTurn(turns, turnId, (turn) => ({
                ...turn,
                assistantContent: `${turn.assistantContent}${event.delta}`,
              })),
            );
            continue;
          }

          if (event.type === "tool") {
            updateAgentTurns(agentId, (turns) =>
              updateTurn(turns, turnId, (turn) => ({
                ...turn,
                tools: [...turn.tools, event.tool],
              })),
            );
            if (event.tool.roomAction && event.tool.roomAction.type !== "read_no_reply") {
              applyRoomToolAction(event.tool.roomAction, agentId);
            }
            continue;
          }

          if (event.type === "room-message") {
            emittedMessages.push(event.message);
            updateRoomState(event.message.roomId, (room) => appendMessageToRoom(room, event.message));
            maybeStartSchedulerForRoomMessage(event.message.roomId, event.message);

            updateAgentTurns(agentId, (turns) =>
              updateTurn(turns, turnId, (turn) => ({
                ...turn,
                emittedMessages: [...turn.emittedMessages, event.message],
              })),
            );
            continue;
          }

          if (event.type === "message-receipt") {
            receiptUpdates.push(event.update);
            updateRoomState(event.update.roomId, (room) => {
              const nextMessages = applyMessageReceiptUpdate(room.roomMessages, event.update);
              if (nextMessages === room.roomMessages) {
                return room;
              }

              return {
                ...room,
                roomMessages: nextMessages,
                receiptRevision: room.receiptRevision + 1,
                updatedAt: createTimestamp(),
              };
            });
            applyReceiptUpdateToAllAgentConsoles(event.update);
            continue;
          }

          if (event.type === "done") {
            updateRoomState(initiatingRoomId, (room) => ({
              ...room,
              roomMessages: updateRoomMessage(room.roomMessages, event.turn.userMessage.id, () => event.turn.userMessage),
              error: "",
              updatedAt: createTimestamp(),
            }));

            updateAgentTurns(agentId, (turns) =>
              updateTurn(turns, turnId, () => ({
                ...event.turn,
                id: turnId,
              })),
            );

            updateAgentState(agentId, (state) => ({
              ...state,
              resolvedModel: event.resolvedModel,
              compatibility: event.compatibility,
              updatedAt: createTimestamp(),
            }));
            continue;
          }

          if (event.type === "error") {
            if (event.meta) {
              const normalizedMeta = normalizeAssistantMeta(event.meta);
              if (normalizedMeta) {
                updateAgentTurns(agentId, (turns) =>
                  updateTurn(turns, turnId, (turn) => ({
                    ...turn,
                    meta: normalizedMeta,
                  })),
                );
              }
            }
            throw new Error(event.error);
          }
        }

        if (done) {
          break;
        }
      }

      if (!isCurrentAgentRun(agentId, requestId)) {
        return {
          emittedMessages,
          receiptUpdates,
        };
      }

      const trailingEvent = parseRoomStreamBlock(buffer);
      if (trailingEvent?.type === "error") {
        if (trailingEvent.meta) {
          const normalizedMeta = normalizeAssistantMeta(trailingEvent.meta);
          if (normalizedMeta) {
            updateAgentTurns(agentId, (turns) =>
              updateTurn(turns, turnId, (turn) => ({
                ...turn,
                meta: normalizedMeta,
              })),
            );
          }
        }
        throw new Error(trailingEvent.error);
      }

      return {
        emittedMessages,
        receiptUpdates,
      };
    },
    [
      applyReceiptUpdateToAllAgentConsoles,
      applyRoomToolAction,
      isCurrentAgentRun,
      maybeStartSchedulerForRoomMessage,
      updateAgentState,
      updateAgentTurns,
      updateRoomState,
    ],
  );

  const executeAgentTurn = useCallback(
    async (args: {
      roomId: string;
      agentId: RoomAgentId;
      inputMessage: RoomMessage;
      runRequestId?: string;
    }): Promise<ExecuteAgentTurnResult> => {
      const roomSnapshot = roomsRef.current.find((room) => room.id === args.roomId);
      if (!roomSnapshot) {
        return {
          status: "aborted",
          emittedMessages: [],
          receiptUpdates: [],
        };
      }

      const roomTitle = roomSnapshot.title;
      const agent = getRoomAgent(args.agentId);
      const pendingTurn = {
        id: crypto.randomUUID(),
        agent: {
          id: agent.id,
          label: agent.label,
        },
        userMessage: args.inputMessage,
        assistantContent: "",
        tools: [],
        emittedMessages: [],
        status: "running" as const,
      };
      const previousActiveRun = getActiveAgentRun(agent.id);
      const requestId = args.runRequestId ?? crypto.randomUUID();
      const controller = new AbortController();
      let emittedMessages: RoomMessage[] = [];
      let receiptUpdates: RoomMessageReceiptUpdate[] = [];

      if (previousActiveRun) {
        updateAgentTurns(agent.id, (turns) =>
          updateTurn(turns, previousActiveRun.turnId, (turn) =>
            turn.status === "running"
              ? {
                  ...turn,
                  status: "continued",
                }
              : turn,
          ),
        );
      }

      updateAgentTurns(agent.id, (turns) => mergeAgentTurns(turns, [pendingTurn]));
      startAgentRun(agent.id, {
        roomId: args.roomId,
        requestId,
        turnId: pendingTurn.id,
        controller,
      });
      previousActiveRun?.controller.abort();

      try {
        const response = await fetch("/api/room-chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({
            message: {
              id: args.inputMessage.id,
              content: args.inputMessage.content,
              sender: args.inputMessage.sender,
            },
          settings: (agentStatesRef.current[agent.id] ?? createAgentSharedState()).settings,
          room: {
            id: args.roomId,
            title: roomTitle,
          },
          attachedRooms: getAttachedRoomsForAgent(agent.id, args.roomId, roomTitle),
          knownAgents: getKnownAgentsForToolContext(),
          roomHistoryById: getRoomHistoryByIdForAgent(agent.id),
          agent: {
            id: agent.id,
            label: agent.label,
            instruction: agent.instruction,
            },
            stream: true,
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error || "The server returned an unknown room error.");
        }

        if (!isCurrentAgentRun(agent.id, requestId)) {
          return {
            status: "superseded",
            emittedMessages,
            receiptUpdates,
          };
        }

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const payload = (await response.json()) as RoomChatResponseBody;
          if (!isCurrentAgentRun(agent.id, requestId)) {
            return {
              status: "superseded",
              emittedMessages,
              receiptUpdates,
            };
          }

          emittedMessages = payload.emittedMessages;
          receiptUpdates = payload.receiptUpdates ?? [];
          applyRoomToolActions(
            payload.turn.tools.flatMap((tool) => (tool.roomAction && tool.roomAction.type !== "read_no_reply" ? [tool.roomAction] : [])),
            agent.id,
          );

          updateRoomState(args.roomId, (room) => {
            let nextRoom = {
              ...room,
              roomMessages: updateRoomMessage(room.roomMessages, payload.turn.userMessage.id, () => ({
                ...payload.turn.userMessage,
                seq: room.roomMessages.find((message) => message.id === payload.turn.userMessage.id)?.seq ?? payload.turn.userMessage.seq,
              })),
              error: "",
              updatedAt: createTimestamp(),
            };

            for (const receiptUpdate of receiptUpdates) {
              const nextMessages = applyMessageReceiptUpdate(nextRoom.roomMessages, receiptUpdate);
              if (nextMessages !== nextRoom.roomMessages) {
                nextRoom = {
                  ...nextRoom,
                  roomMessages: nextMessages,
                  receiptRevision: nextRoom.receiptRevision + 1,
                };
              }
            }

            for (const emittedMessage of emittedMessages) {
              nextRoom = appendMessageToRoom(nextRoom, emittedMessage);
            }

            return nextRoom;
          });
          for (const emittedMessage of emittedMessages) {
            maybeStartSchedulerForRoomMessage(emittedMessage.roomId, emittedMessage);
          }
          for (const receiptUpdate of receiptUpdates) {
            applyReceiptUpdateToAllAgentConsoles(receiptUpdate);
          }

          updateAgentTurns(agent.id, (turns) =>
            updateTurn(turns, pendingTurn.id, () => ({
              ...payload.turn,
              id: pendingTurn.id,
            })),
          );

          updateAgentState(agent.id, (state) => ({
            ...state,
            resolvedModel: payload.resolvedModel,
            compatibility: payload.compatibility,
            updatedAt: createTimestamp(),
          }));
        } else {
          const streamResult = await readRoomStream(response, args.roomId, agent.id, pendingTurn.id, requestId);
          emittedMessages = streamResult.emittedMessages;
          receiptUpdates = streamResult.receiptUpdates;
          if (!isCurrentAgentRun(agent.id, requestId)) {
            return {
              status: "superseded",
              emittedMessages,
              receiptUpdates,
            };
          }
        }

        return {
          status: "completed",
          emittedMessages,
          receiptUpdates,
        };
      } catch (caughtError) {
        if (!isCurrentAgentRun(agent.id, requestId)) {
          return {
            status: "superseded",
            emittedMessages,
            receiptUpdates,
          };
        }

        if (controller.signal.aborted) {
          return {
            status: "aborted",
            emittedMessages,
            receiptUpdates,
          };
        }

        const message = caughtError instanceof Error ? caughtError.message : "Unknown request failure.";
        updateRoomState(args.roomId, (room) => ({
          ...room,
          error: message,
          updatedAt: createTimestamp(),
        }));
        updateAgentTurns(agent.id, (turns) =>
          updateTurn(turns, pendingTurn.id, (turn) => ({
            ...turn,
            status: "error",
            error: message,
          })),
        );
        return {
          status: "error",
          emittedMessages,
          receiptUpdates,
        };
      } finally {
        finishAgentRun(agent.id, requestId);
        const schedulerRun = activeSchedulerRunsRef.current[args.roomId];
        if (schedulerRun?.activeRequestId === requestId) {
          activeSchedulerRunsRef.current[args.roomId] = {
            ...schedulerRun,
            activeAgentId: null,
            activeRequestId: null,
          };
        }
      }
    },
    [
      applyReceiptUpdateToAllAgentConsoles,
      applyRoomToolActions,
      finishAgentRun,
      getActiveAgentRun,
      getAttachedRoomsForAgent,
      getKnownAgentsForToolContext,
      getRoomHistoryByIdForAgent,
      isCurrentAgentRun,
      maybeStartSchedulerForRoomMessage,
      readRoomStream,
      startAgentRun,
      updateAgentState,
      updateAgentTurns,
      updateRoomState,
    ],
  );

  const runRoomScheduler = useCallback(
    async (roomId: string) => {
      const cycleId = crypto.randomUUID();
      interruptRoomScheduler(roomId);
      activeSchedulerRunsRef.current[roomId] = {
        cycleId,
        activeAgentId: null,
        activeRequestId: null,
      };

      let idlePassCount = 0;
      let dispatchedRounds = 0;

      while (true) {
        if (activeSchedulerRunsRef.current[roomId]?.cycleId !== cycleId) {
          return;
        }

        const roomSnapshot = roomsRef.current.find((room) => room.id === roomId);
        if (!roomSnapshot) {
          return;
        }

        const nextParticipant = getNextAgentParticipant(roomSnapshot);
        const enabledAgents = getEnabledAgentParticipants(roomSnapshot);
        if (!nextParticipant || enabledAgents.length === 0) {
          updateRoomState(roomId, (room) => ({
            ...room,
            scheduler: {
              ...room.scheduler,
              status: "idle",
              activeParticipantId: null,
              roundCount: 0,
            },
          }));
          return;
        }

        const nextAfterParticipant = getNextAgentParticipant(roomSnapshot, nextParticipant.id);
        const cutoffSeq = roomSnapshot.roomMessages[roomSnapshot.roomMessages.length - 1]?.seq ?? 0;
        const lastCursor = roomSnapshot.scheduler.agentCursorByParticipantId[nextParticipant.id] ?? 0;
        const unseenMessages = roomSnapshot.roomMessages.filter(
          (message) => message.seq > lastCursor && message.seq <= cutoffSeq && message.sender.id !== nextParticipant.id,
        );
        const messagesForTurn = unseenMessages;
        const visibleTargetMessages = getSchedulerVisibleTargetMessages(messagesForTurn, nextParticipant);

        updateRoomState(roomId, (room) => ({
          ...room,
          agentId: getPrimaryRoomAgentId(room),
          scheduler: {
            ...room.scheduler,
            status: "running",
            activeParticipantId: visibleTargetMessages.length > 0 ? nextParticipant.id : null,
            nextAgentParticipantId: nextAfterParticipant?.id ?? nextParticipant.id,
            roundCount: dispatchedRounds,
            agentCursorByParticipantId: {
              ...room.scheduler.agentCursorByParticipantId,
              [nextParticipant.id]: cutoffSeq,
            },
            agentReceiptRevisionByParticipantId: {
              ...room.scheduler.agentReceiptRevisionByParticipantId,
              [nextParticipant.id]: roomSnapshot.receiptRevision,
            },
          },
          updatedAt: createTimestamp(),
        }));

        if (visibleTargetMessages.length === 0) {
          idlePassCount += 1;
          if (idlePassCount >= enabledAgents.length) {
            updateRoomState(roomId, (room) => ({
              ...room,
              scheduler: {
                ...room.scheduler,
                status: "idle",
                activeParticipantId: null,
                roundCount: 0,
              },
              updatedAt: createTimestamp(),
            }));
            return;
          }
          continue;
        }

        idlePassCount = 0;
        dispatchedRounds += 1;
        if (dispatchedRounds > ROOM_LOOP_MAX_ROUNDS) {
          updateRoomState(roomId, (room) => ({
            ...room,
            error: `Room scheduler stopped after ${ROOM_LOOP_MAX_ROUNDS} agent rounds.`,
            scheduler: {
              ...room.scheduler,
              status: "idle",
              activeParticipantId: null,
              roundCount: 0,
            },
            updatedAt: createTimestamp(),
          }));
          return;
        }

        updateRoomState(roomId, (room) => ({
          ...room,
          scheduler: {
            ...room.scheduler,
            roundCount: dispatchedRounds,
          },
        }));

        const requestId = crypto.randomUUID();
        activeSchedulerRunsRef.current[roomId] = {
          ...(activeSchedulerRunsRef.current[roomId] ?? {
            cycleId,
            activeAgentId: null,
            activeRequestId: null,
          }),
          cycleId,
          activeAgentId: nextParticipant.agentId ?? null,
          activeRequestId: requestId,
        };

        const schedulerPacket = createRoomMessage(
          roomId,
          "system",
          buildSchedulerPacketContent(roomSnapshot, nextParticipant, messagesForTurn, {
            hasNewDelta: unseenMessages.length > 0,
          }),
          "system",
          {
            sender: ROOM_SCHEDULER_SENDER,
            kind: "system",
            status: "completed",
            final: true,
          },
        );
        schedulerPacket.id = requestId;

        const result = await executeAgentTurn({
          roomId,
          agentId: nextParticipant.agentId ?? DEFAULT_AGENT_ID,
          inputMessage: schedulerPacket,
          runRequestId: requestId,
        });

        if (result.status !== "completed") {
          updateRoomState(roomId, (room) => ({
            ...room,
            scheduler: {
              ...room.scheduler,
              status: "idle",
              activeParticipantId: null,
              roundCount: 0,
            },
            updatedAt: createTimestamp(),
          }));
          return;
        }

        const latestSchedulerRun = activeSchedulerRunsRef.current[roomId];
        if (latestSchedulerRun?.cycleId !== cycleId) {
          return;
        }
      }
    },
    [executeAgentTurn, interruptRoomScheduler, updateRoomState],
  );

  useEffect(() => {
    runRoomSchedulerRef.current = runRoomScheduler;
  }, [runRoomScheduler]);

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

  const createRoom = useCallback(
    (agentId: RoomAgentId = DEFAULT_AGENT_ID) => {
      const nextRoom = createRoomSession(getNextRoomIndex(roomsRef.current), agentId);
      replaceRooms(sortRoomsByUpdatedAt([nextRoom, ...roomsRef.current]));
      setActiveRoomId(nextRoom.id);
      setSelectedSenderByRoomId((current) => ({
        ...current,
        [nextRoom.id]: DEFAULT_LOCAL_PARTICIPANT_ID,
      }));
      return nextRoom;
    },
    [replaceRooms],
  );

  const renameRoom = useCallback(
    (roomId: string, title: string) => {
      const normalizedTitle = title.trim();
      if (!normalizedTitle) {
        return;
      }

      replaceRooms(
        sortRoomsByUpdatedAt(
          roomsRef.current.map((room) =>
            room.id === roomId
              ? {
                  ...room,
                  title: normalizedTitle,
                  updatedAt: createTimestamp(),
                }
              : room,
          ),
        ),
      );
    },
    [replaceRooms],
  );

  const archiveRoom = useCallback(
    (roomId: string) => {
      const targetRoom = roomsRef.current.find((room) => room.id === roomId);
      if (!targetRoom || roomHasRunningAgent(targetRoom)) {
        return;
      }

      clearDraftForRoom(roomId);
      replaceRooms(
        sortRoomsByUpdatedAt(
          roomsRef.current.map((room) =>
            room.id === roomId
              ? {
                  ...room,
                  archivedAt: createTimestamp(),
                  updatedAt: createTimestamp(),
                }
              : room,
          ),
        ),
      );
    },
    [clearDraftForRoom, replaceRooms, roomHasRunningAgent],
  );

  const restoreRoom = useCallback(
    (roomId: string) => {
      const targetRoom = roomsRef.current.find((room) => room.id === roomId);
      if (!targetRoom || roomHasRunningAgent(targetRoom)) {
        return;
      }

      replaceRooms(
        sortRoomsByUpdatedAt(
          roomsRef.current.map((room) =>
            room.id === roomId
              ? {
                  ...room,
                  archivedAt: null,
                  updatedAt: createTimestamp(),
                }
              : room,
          ),
        ),
      );
      setActiveRoomId(roomId);
    },
    [replaceRooms, roomHasRunningAgent],
  );

  const deleteRoom = useCallback(
    (roomId: string) => {
      const targetRoom = roomsRef.current.find((room) => room.id === roomId);
      if (!targetRoom || roomHasRunningAgent(targetRoom)) {
        return;
      }

      clearDraftForRoom(roomId);
      setSelectedSenderByRoomId((current) => {
        const nextState = { ...current };
        delete nextState[roomId];
        return nextState;
      });
      replaceRooms(sortRoomsByUpdatedAt(roomsRef.current.filter((room) => room.id !== roomId)));
    },
    [clearDraftForRoom, replaceRooms, roomHasRunningAgent],
  );

  const clearRoom = useCallback(
    (roomId: string) => {
      const room = roomsRef.current.find((entry) => entry.id === roomId);
      if (!room || roomHasRunningAgent(room)) {
        return;
      }

      clearDraftForRoom(roomId);
      updateRoomState(roomId, (currentRoom) => ({
        ...currentRoom,
        roomMessages: [],
        receiptRevision: 0,
        scheduler: {
          ...currentRoom.scheduler,
          status: "idle",
          activeParticipantId: null,
          roundCount: 0,
          agentCursorByParticipantId: {},
          agentReceiptRevisionByParticipantId: {},
        },
        error: "",
        updatedAt: createTimestamp(),
      }));
    },
    [clearDraftForRoom, roomHasRunningAgent, updateRoomState],
  );

  const addHumanParticipant = useCallback(
    (roomId: string, name: string) => {
      const normalizedName = name.trim();
      const room = roomsRef.current.find((entry) => entry.id === roomId);
      if (!room || roomHasRunningAgent(room) || !normalizedName) {
        return;
      }

      updateRoomState(roomId, (currentRoom) => {
        let nextRoom = syncRoomParticipants(currentRoom, [
          ...currentRoom.participants,
          createHumanParticipant(normalizedName, createParticipantId("human")),
        ]);
        nextRoom = appendMessageToRoom(nextRoom, createSystemRoomEvent(nextRoom, `You added ${normalizedName} to the room.`));
        return nextRoom;
      });
    },
    [roomHasRunningAgent, updateRoomState],
  );

  const addAgentParticipant = useCallback(
    (roomId: string, agentId: RoomAgentId) => {
      const room = roomsRef.current.find((entry) => entry.id === roomId);
      if (!room || roomHasRunningAgent(room)) {
        return;
      }

      updateRoomState(roomId, (currentRoom) => {
        if (currentRoom.participants.some((participant) => participant.runtimeKind === "agent" && participant.agentId === agentId)) {
          return currentRoom;
        }

        let nextRoom = syncRoomParticipants(currentRoom, [
          ...currentRoom.participants,
          createAgentParticipant(agentId, getAgentParticipants(currentRoom).length + 1),
        ]);
        nextRoom = appendMessageToRoom(nextRoom, createSystemRoomEvent(nextRoom, `You added ${getRoomAgent(agentId).label} to the room.`));
        return nextRoom;
      });
    },
    [roomHasRunningAgent, updateRoomState],
  );

  const removeParticipant = useCallback(
    (roomId: string, participantId: string) => {
      const room = roomsRef.current.find((entry) => entry.id === roomId);
      if (!room || roomHasRunningAgent(room)) {
        return;
      }

      updateRoomState(roomId, (currentRoom) => {
        const removedParticipant = currentRoom.participants.find((participant) => participant.id === participantId);
        const nextParticipants = currentRoom.participants.filter((participant) => participant.id !== participantId);
        if (nextParticipants.length === currentRoom.participants.length) {
          return currentRoom;
        }

        let nextRoom = syncRoomParticipants(currentRoom, nextParticipants);
        nextRoom = appendMessageToRoom(
          nextRoom,
          createSystemRoomEvent(nextRoom, `You removed ${removedParticipant?.name || participantId} from the room.`),
        );
        return nextRoom;
      });
    },
    [roomHasRunningAgent, updateRoomState],
  );

  const toggleAgentParticipant = useCallback(
    (roomId: string, participantId: string) => {
      const room = roomsRef.current.find((entry) => entry.id === roomId);
      if (!room || roomHasRunningAgent(room)) {
        return;
      }

      updateRoomState(roomId, (currentRoom) =>
        syncRoomParticipants(
          currentRoom,
          currentRoom.participants.map((participant) =>
            participant.id === participantId && participant.runtimeKind === "agent"
              ? {
                  ...participant,
                  enabled: !participant.enabled,
                  updatedAt: createTimestamp(),
                }
              : participant,
          ),
        ),
      );
    },
    [roomHasRunningAgent, updateRoomState],
  );

  const moveAgentParticipant = useCallback(
    (roomId: string, participantId: string, direction: -1 | 1) => {
      const room = roomsRef.current.find((entry) => entry.id === roomId);
      if (!room || roomHasRunningAgent(room)) {
        return;
      }

      updateRoomState(roomId, (currentRoom) => {
        const agents = getAgentParticipants(currentRoom);
        const agentIndex = agents.findIndex((participant) => participant.id === participantId);
        const targetIndex = agentIndex + direction;
        if (agentIndex < 0 || targetIndex < 0 || targetIndex >= agents.length) {
          return currentRoom;
        }

        const reorderedAgents = [...agents];
        const [movedAgent] = reorderedAgents.splice(agentIndex, 1);
        reorderedAgents.splice(targetIndex, 0, movedAgent);
        const reorderedById = new Map(reorderedAgents.map((participant, index) => [participant.id, index + 1]));

        return syncRoomParticipants(
          currentRoom,
          currentRoom.participants.map((participant) =>
            participant.runtimeKind === "agent"
              ? {
                  ...participant,
                  order: reorderedById.get(participant.id) ?? participant.order,
                  updatedAt: createTimestamp(),
                }
              : participant,
          ),
        );
      });
    },
    [roomHasRunningAgent, updateRoomState],
  );

  const sendMessage = useCallback(
    async ({ roomId, content, senderId }: SendMessageArgs) => {
      const roomSnapshot = roomsRef.current.find((room) => room.id === roomId && !room.archivedAt);
      if (!roomSnapshot) {
        return;
      }

      const normalizedContent = content.trim();
      if (!normalizedContent) {
        return;
      }

      const humanParticipants = getHumanParticipants(roomSnapshot);
      const sender =
        humanParticipants.find((participant) => participant.id === senderId) ??
        (senderId === DEFAULT_LOCAL_PARTICIPANT_ID ? createHumanParticipant(LOCAL_PARTICIPANT_SENDER.name, DEFAULT_LOCAL_PARTICIPANT_ID) : null) ??
        humanParticipants[0];
      if (!sender) {
        return;
      }

      const nextTitle = shouldAutoTitleRoom(roomSnapshot) ? getSuggestedRoomTitle(normalizedContent) || roomSnapshot.title : roomSnapshot.title;
      const roomUserMessage = createRoomMessage(roomId, "user", normalizedContent, "user", {
        seq: getNextRoomMessageSeq(roomSnapshot),
        sender: getParticipantSender(sender),
        kind: "user_input",
        status: "completed",
        final: true,
      });

      setActiveRoomId(roomId);
      setSelectedSender(roomId, sender.id);
      interruptRoomScheduler(roomId);
      updateRoomState(roomId, (room) => {
        const roomWithHumanMembership =
          sender.runtimeKind === "human" && !room.participants.some((participant) => participant.id === sender.id)
            ? syncRoomParticipants(room, [...room.participants, createHumanParticipant(sender.name, sender.id)])
            : room;
        const nextRoom = appendMessageToRoom(
          {
            ...roomWithHumanMembership,
            title: nextTitle,
            error: "",
          },
          roomUserMessage,
        );
        return {
          ...nextRoom,
          agentId: getPrimaryRoomAgentId(nextRoom),
        };
      });
      clearDraftForRoom(roomId);
      await runRoomScheduler(roomId);
    },
    [clearDraftForRoom, interruptRoomScheduler, runRoomScheduler, setSelectedSender, updateRoomState],
  );

  const clearAllWorkspace = useCallback(async () => {
    Object.values(activeRunsRef.current).forEach((run) => run.controller.abort(new Error("Workspace reset by operator.")));
    activeRunsRef.current = {};
    activeSchedulerRunsRef.current = {};

    const initialRoom = createRoomSession(1);
    const initialAgentStates = createInitialAgentStates();

    roomsRef.current = [initialRoom];
    agentStatesRef.current = initialAgentStates;

    setRooms([initialRoom]);
    setAgentStates(initialAgentStates);
    setActiveRoomId(initialRoom.id);
    setSelectedConsoleAgentId(initialRoom.agentId);
    setSelectedSenderByRoomId({});
    setDraftsByRoomId({});
    setRunningAgentRequestIds({});
    setResettingAgentContextIds({});

    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PREVIOUS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);

    await Promise.allSettled(
      ROOM_AGENTS.map((agent) =>
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

        if (!response.ok) {
          throw new Error("Failed to compact agent context.");
        }

        updateAgentState(agentId, (state) => ({
          ...state,
          updatedAt: createTimestamp(),
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
          maxToolLoopSteps: coerceMaxToolLoopSteps(patch.maxToolLoopSteps ?? state.settings.maxToolLoopSteps),
          thinkingLevel: coerceThinkingLevel(patch.thinkingLevel ?? state.settings.thinkingLevel),
          enabledSkillIds: coerceSkillIds(patch.enabledSkillIds ?? state.settings.enabledSkillIds),
        },
        updatedAt: createTimestamp(),
      }));
    },
    [updateAgentState],
  );

  const getRoomById = useCallback((roomId: string) => {
    return roomsRef.current.find((room) => room.id === roomId) ?? null;
  }, []);

  const isAgentRunning = useCallback(
    (agentId: RoomAgentId) => {
      return Boolean(runningAgentRequestIds[agentId]);
    },
    [runningAgentRequestIds],
  );

  const isRoomRunning = useCallback(
    (roomId: string) => {
      const room = roomsRef.current.find((entry) => entry.id === roomId);
      return room ? roomHasRunningAgent(room) : false;
    },
    [roomHasRunningAgent],
  );

  const contextValue = useMemo<WorkspaceContextValue>(
    () => ({
      hydrated,
      rooms,
      activeRooms,
      archivedRooms,
      activeRoomId,
      activeRoom,
      agentStates,
      runningAgentRequestIds,
      selectedConsoleAgentId,
      selectedSenderByRoomId,
      draftsByRoomId,
      setActiveRoomId,
      setSelectedConsoleAgentId,
      setSelectedSender,
      setDraft,
      getRoomById,
      isAgentRunning,
      isRoomRunning,
      createRoom,
      renameRoom,
      archiveRoom,
      restoreRoom,
      deleteRoom,
      clearRoom,
      addHumanParticipant,
      addAgentParticipant,
      removeParticipant,
      toggleAgentParticipant,
      moveAgentParticipant,
      sendMessage,
      clearAllWorkspace,
      clearAgentConsole,
      resetAgentContext,
      compactAgentContext,
      updateAgentSettings,
    }),
    [
      activeRoom,
      activeRoomId,
      activeRooms,
      addAgentParticipant,
      addHumanParticipant,
      agentStates,
      archiveRoom,
      archivedRooms,
      clearAgentConsole,
      compactAgentContext,
      clearRoom,
      createRoom,
      deleteRoom,
      draftsByRoomId,
      getRoomById,
      hydrated,
      isAgentRunning,
      isRoomRunning,
      moveAgentParticipant,
      removeParticipant,
      resetAgentContext,
      renameRoom,
      restoreRoom,
      rooms,
      runningAgentRequestIds,
      selectedConsoleAgentId,
      selectedSenderByRoomId,
      sendMessage,
      clearAllWorkspace,
      setDraft,
      setSelectedSender,
      toggleAgentParticipant,
      updateAgentSettings,
    ],
  );

  return <WorkspaceContext.Provider value={contextValue}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used inside WorkspaceProvider.");
  }

  return context;
}

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
