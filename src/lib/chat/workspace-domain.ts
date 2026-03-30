import { ROOM_AGENTS } from "@/lib/chat/catalog";
import { formatMessageForTranscript } from "@/lib/chat/message-attachments";
import type {
  AgentInfoCard,
  AgentSharedState,
  ChatSettings,
  ProviderCompatibility,
  RoomAgentDefinition,
  RoomAgentId,
  RoomHistoryMessageSummary,
  RoomMessage,
  RoomMessageReceipt,
  RoomMessageReceiptUpdate,
  RoomParticipant,
  RoomSchedulerState,
  RoomSender,
  RoomSession,
  RoomToolActionUnion,
  RoomWorkspaceState,
  ToolExecution,
} from "@/lib/chat/types";
import { DEFAULT_MAX_TOOL_LOOP_STEPS } from "@/lib/chat/types";
import { createUuid } from "@/lib/utils/uuid";

export const DEFAULT_AGENT_ID: RoomAgentId = "concierge";
export const DEFAULT_LOCAL_PARTICIPANT_ID = "local-operator";

const DEFAULT_SETTINGS: ChatSettings = {
  modelConfigId: null,
  apiFormat: "chat_completions",
  model: "",
  systemPrompt: "",
  providerMode: "auto",
  memoryBackend: "sqlite-fts",
  maxToolLoopSteps: DEFAULT_MAX_TOOL_LOOP_STEPS,
  thinkingLevel: "off",
  enabledSkillIds: [] as string[],
};

const DEFAULT_LOCAL_PARTICIPANT_SENDER: RoomSender = {
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

export function createTimestamp(): string {
  return new Date().toISOString();
}

function formatAgentLabel(agentId: string): string {
  const trimmed = agentId.trim();
  if (!trimmed) {
    return "Agent";
  }

  return trimmed
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || trimmed;
}

export function createFallbackRoomAgent(agentId: RoomAgentId): RoomAgentDefinition {
  return {
    id: agentId,
    label: formatAgentLabel(agentId),
    summary: `Custom agent ${agentId}.`,
    skills: [],
    workingStyle: "Custom, workspace-backed agent.",
    instruction: "",
  };
}

export function getRoomAgent(agentId: RoomAgentId, agentDefinitions: RoomAgentDefinition[] = ROOM_AGENTS): RoomAgentDefinition {
  return agentDefinitions.find((agent) => agent.id === agentId) ?? createFallbackRoomAgent(agentId);
}

export function sortRoomsByUpdatedAt(rooms: RoomSession[]): RoomSession[] {
  return [...rooms].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function createAgentSharedState(overrides?: Partial<AgentSharedState>): AgentSharedState {
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

export function createInitialAgentStates(agentDefinitions: RoomAgentDefinition[] = ROOM_AGENTS): Record<RoomAgentId, AgentSharedState> {
  const definitions = agentDefinitions.length > 0 ? agentDefinitions : [getRoomAgent(DEFAULT_AGENT_ID)];
  return Object.fromEntries(definitions.map((agent) => [agent.id, createAgentSharedState()])) as Record<RoomAgentId, AgentSharedState>;
}

export function createHumanParticipant(name: string, id = DEFAULT_LOCAL_PARTICIPANT_ID): RoomParticipant {
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

export function createAgentParticipant(agentId: RoomAgentId, order: number, agentDefinitions: RoomAgentDefinition[] = ROOM_AGENTS): RoomParticipant {
  const timestamp = createTimestamp();
  const agent = getRoomAgent(agentId, agentDefinitions);
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

export function pickRoomOwnerParticipantId(participants: RoomParticipant[], preferredOwnerId?: string | null): string | null {
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

function getParticipantMembershipRole(room: RoomSession, participantId: string): "owner" | "member" {
  return room.ownerParticipantId === participantId ? "owner" : "member";
}

export function sortRoomParticipants(participants: RoomParticipant[]): RoomParticipant[] {
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

export function getAgentParticipants(room: RoomSession): RoomParticipant[] {
  return room.participants.filter((participant) => participant.runtimeKind === "agent");
}

export function getEnabledAgentParticipants(room: RoomSession): RoomParticipant[] {
  return getAgentParticipants(room).filter((participant) => participant.enabled);
}

export function getHumanParticipants(room: RoomSession): RoomParticipant[] {
  return room.participants.filter((participant) => participant.runtimeKind === "human");
}

export function getPrimaryRoomAgentId(room: RoomSession): RoomAgentId {
  return getEnabledAgentParticipants(room)[0]?.agentId ?? room.agentId;
}

export function createSchedulerState(agentParticipantId: string | null): RoomSchedulerState {
  return {
    status: "idle",
    nextAgentParticipantId: agentParticipantId,
    activeParticipantId: null,
    roundCount: 0,
    agentCursorByParticipantId: {},
    agentReceiptRevisionByParticipantId: {},
  };
}

export function createRoomSession(index: number, agentId: RoomAgentId = DEFAULT_AGENT_ID, agentDefinitions: RoomAgentDefinition[] = ROOM_AGENTS): RoomSession {
  const timestamp = createTimestamp();
  const participants = sortRoomParticipants([
    createHumanParticipant(DEFAULT_LOCAL_PARTICIPANT_SENDER.name),
    createAgentParticipant(agentId, 1, agentDefinitions),
  ]);

  return {
    id: createUuid(),
    title: `Room ${index}`,
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

export function createExternalRoomSession(args: {
  roomId: string;
  title: string;
  agentId: RoomAgentId;
  humanParticipantId: string;
  humanParticipantName: string;
  agentDefinitions?: RoomAgentDefinition[];
}): RoomSession {
  const timestamp = createTimestamp();
  const participants = sortRoomParticipants([
    createHumanParticipant(args.humanParticipantName, args.humanParticipantId),
    createAgentParticipant(args.agentId, 1, args.agentDefinitions),
  ]);

  return {
    id: args.roomId,
    title: args.title,
    agentId: args.agentId,
    archivedAt: null,
    ownerParticipantId: args.humanParticipantId,
    receiptRevision: 0,
    participants,
    scheduler: createSchedulerState(args.agentId),
    roomMessages: [],
    agentTurns: [],
    error: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createDefaultWorkspaceState(agentDefinitions: RoomAgentDefinition[] = ROOM_AGENTS): RoomWorkspaceState {
  const initialRoom = createRoomSession(1, DEFAULT_AGENT_ID, agentDefinitions);
  return {
    rooms: [initialRoom],
    agentStates: createInitialAgentStates(agentDefinitions),
    activeRoomId: initialRoom.id,
    selectedConsoleAgentId: initialRoom.agentId,
  };
}

export function getNextRoomMessageSeq(room: RoomSession): number {
  return (room.roomMessages[room.roomMessages.length - 1]?.seq ?? 0) + 1;
}

export function createRoomMessage(
  roomId: string,
  role: RoomMessage["role"],
  content: string,
  source: RoomMessage["source"],
  options?: Partial<Pick<RoomMessage, "kind" | "status" | "final" | "sender" | "seq" | "attachments">>,
): RoomMessage {
  const defaultKind = role === "user" ? "user_input" : role === "system" ? "system" : "answer";
  const defaultSender =
    role === "system" || source === "system"
      ? SYSTEM_SENDER
      : role === "assistant" || source === "agent_emit"
        ? GENERIC_AGENT_SENDER
        : DEFAULT_LOCAL_PARTICIPANT_SENDER;

  return {
    id: createUuid(),
    roomId,
    seq: options?.seq ?? 0,
    role,
    sender: options?.sender || defaultSender,
    content,
    attachments: options?.attachments ? [...options.attachments] : [],
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

function sortRoomMessageReceipts(receipts: RoomMessageReceipt[]): RoomMessageReceipt[] {
  return [...receipts].sort((left, right) => {
    const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }

    return left.participantName.localeCompare(right.participantName);
  });
}

export function getReceiptStatus(receipts: RoomMessageReceipt[]): RoomMessage["receiptStatus"] {
  return receipts.length > 0 ? "read_no_reply" : "none";
}

export function getReceiptUpdatedAt(receipts: RoomMessageReceipt[]): string | null {
  return receipts.length > 0 ? receipts[receipts.length - 1]?.createdAt ?? null : null;
}

export function upsertRoomMessageReceipt(receipts: RoomMessageReceipt[], receipt: RoomMessageReceipt): RoomMessageReceipt[] {
  if (receipts.some((entry) => entry.participantId === receipt.participantId)) {
    return receipts;
  }

  const nextReceipts = receipts.filter((entry) => entry.participantId !== receipt.participantId);
  nextReceipts.push(receipt);
  return sortRoomMessageReceipts(nextReceipts);
}

function updateRoomMessage(
  messages: RoomMessage[],
  messageId: string,
  updater: (message: RoomMessage) => RoomMessage,
): RoomMessage[] {
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    changed = true;
    return updater(message);
  });

  return changed ? nextMessages : messages;
}

function mergeRoomMessage(existing: RoomMessage, next: RoomMessage): RoomMessage {
  return {
    ...existing,
    ...next,
    id: existing.id,
    roomId: existing.roomId,
    seq: existing.seq,
    role: existing.role,
    sender: existing.sender,
    source: existing.source,
    createdAt: existing.createdAt,
  };
}

export function upsertRoomMessages(messages: RoomMessage[], message: RoomMessage): RoomMessage[] {
  const existingIndex = messages.findIndex((entry) => entry.id === message.id);
  if (existingIndex < 0) {
    return [...messages, message];
  }

  const nextMessages = [...messages];
  nextMessages[existingIndex] = mergeRoomMessage(messages[existingIndex], message);
  return nextMessages;
}

export function appendMessageToRoom(room: RoomSession, message: RoomMessage): RoomSession {
  return {
    ...room,
    roomMessages: [...room.roomMessages, { ...message, roomId: room.id, seq: message.seq || getNextRoomMessageSeq(room) }],
    updatedAt: createTimestamp(),
  };
}

export function upsertMessageToRoom(room: RoomSession, message: RoomMessage): RoomSession {
  const existingMessage = room.roomMessages.find((entry) => entry.id === message.id);
  if (!existingMessage) {
    return appendMessageToRoom(room, message);
  }

  return {
    ...room,
    roomMessages: room.roomMessages.map((entry) =>
      entry.id === message.id ? mergeRoomMessage(entry, { ...message, roomId: room.id, seq: entry.seq }) : entry,
    ),
    updatedAt: createTimestamp(),
  };
}

export function dedupeRoomMessages(messages: RoomMessage[]): RoomMessage[] {
  const dedupedMessages: RoomMessage[] = [];

  for (const message of messages) {
    const existingIndex = dedupedMessages.findIndex((entry) => entry.id === message.id);
    if (existingIndex < 0) {
      dedupedMessages.push(message);
      continue;
    }

    dedupedMessages[existingIndex] = mergeRoomMessage(dedupedMessages[existingIndex], message);
  }

  return dedupedMessages;
}

export function syncRoomParticipants(room: RoomSession, participants: RoomParticipant[]): RoomSession {
  const nextParticipants = sortRoomParticipants(participants);
  const enabledAgents = nextParticipants.filter((participant) => participant.runtimeKind === "agent" && participant.enabled);
  const nextOwnerParticipantId = pickRoomOwnerParticipantId(nextParticipants, room.ownerParticipantId);
  const nextPrimaryAgentId = enabledAgents[0]?.agentId ?? room.agentId;
  const nextSchedulerParticipantId =
    room.scheduler.nextAgentParticipantId && enabledAgents.some((participant) => participant.id === room.scheduler.nextAgentParticipantId)
      ? room.scheduler.nextAgentParticipantId
      : enabledAgents[0]?.id ?? null;
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
    participants: nextParticipants,
    ownerParticipantId: nextOwnerParticipantId,
    agentId: nextPrimaryAgentId,
    scheduler: {
      ...room.scheduler,
      nextAgentParticipantId: nextSchedulerParticipantId,
      activeParticipantId: nextActiveParticipantId,
      agentCursorByParticipantId: nextAgentCursorByParticipantId,
      agentReceiptRevisionByParticipantId: nextAgentReceiptRevisionByParticipantId,
    },
    updatedAt: createTimestamp(),
  };
}

export function applyMessageReceiptUpdate(messages: RoomMessage[], update: RoomMessageReceiptUpdate): RoomMessage[] {
  return updateRoomMessage(messages, update.messageId, (message) => {
    const receipts = upsertRoomMessageReceipt(message.receipts, update.receipt);
    if (receipts === message.receipts) {
      return message;
    }

    return {
      ...message,
      receipts,
      receiptStatus: update.receiptStatus,
      receiptUpdatedAt: update.receiptUpdatedAt,
    };
  });
}

export function getActiveRooms(rooms: RoomSession[]): RoomSession[] {
  return rooms.filter((room) => !room.archivedAt);
}

export function getArchivedRooms(rooms: RoomSession[]): RoomSession[] {
  return rooms.filter((room) => Boolean(room.archivedAt));
}

function getRoomOwnerParticipant(room: RoomSession): RoomParticipant | null {
  return room.participants.find((participant) => participant.id === room.ownerParticipantId) ?? null;
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
    ...(participant.agentId ? { agentId: participant.agentId } : {}),
  };
}

export function createAttachedRoomDefinition(room: RoomSession, currentAgentId?: RoomAgentId) {
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
    currentAgentIsOwner: currentAgentParticipant ? room.ownerParticipantId === currentAgentParticipant.id : false,
    participants: room.participants.map((participant) => createRoomParticipantSnapshot(room, participant)),
    messageCount: room.roomMessages.length,
    latestMessageAt: room.roomMessages[room.roomMessages.length - 1]?.createdAt ?? null,
  };
}

export function createRoomHistorySummary(room: RoomSession): RoomHistoryMessageSummary[] {
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
    attachments: [...message.attachments],
    receipts: [...message.receipts],
  }));
}

export function createKnownAgentCards(agentDefinitions: RoomAgentDefinition[] = ROOM_AGENTS): AgentInfoCard[] {
  return agentDefinitions.map((agent) => ({
    agentId: agent.id,
    label: agent.label,
    summary: agent.summary,
    skills: [...agent.skills],
    workingStyle: agent.workingStyle,
  }));
}

export function createSystemRoomEvent(room: RoomSession, content: string): RoomMessage {
  return createRoomMessage(room.id, "system", content, "system", {
    seq: getNextRoomMessageSeq(room),
    sender: SYSTEM_SENDER,
    kind: "system",
    status: "completed",
    final: true,
  });
}

export function createAgentOwnedRoomSession(
  roomId: string,
  title: string,
  ownerAgentId: RoomAgentId,
  agentIds: RoomAgentId[],
  agentDefinitions: RoomAgentDefinition[] = ROOM_AGENTS,
): RoomSession {
  const timestamp = createTimestamp();
  const uniqueAgentIds = [...new Set(agentIds.length > 0 ? agentIds : [ownerAgentId])];
  const participants = sortRoomParticipants(uniqueAgentIds.map((agentId, index) => createAgentParticipant(agentId, index + 1, agentDefinitions)));

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
  room = appendMessageToRoom(room, createSystemRoomEvent(room, `${getRoomAgent(ownerAgentId, agentDefinitions).label} created this room with ${memberNames}.`));
  return room;
}

export function reduceRoomManagementActions(
  currentRooms: RoomSession[],
  actions: RoomToolActionUnion[],
  actorAgentId: RoomAgentId,
  agentDefinitions: RoomAgentDefinition[] = ROOM_AGENTS,
): RoomSession[] {
  let nextRooms = currentRooms;

  for (const action of actions) {
    if (action.type === "read_no_reply") {
      continue;
    }

    if (action.type === "create_room") {
      if (nextRooms.some((room) => room.id === action.roomId)) {
        continue;
      }
      const nextRoom = createAgentOwnedRoomSession(action.roomId, action.title, actorAgentId, action.agentIds, agentDefinitions);
      nextRooms = [nextRoom, ...nextRooms];
      continue;
    }

    if (action.type === "add_agents_to_room") {
      nextRooms = nextRooms.map((room) => {
        if (room.id !== action.roomId || room.archivedAt) {
          return room;
        }
        const existingAgentIds = new Set(
          getAgentParticipants(room).flatMap((participant) => (participant.agentId ? [participant.agentId] : [])),
        );
        const additions = action.agentIds.filter((agentId) => !existingAgentIds.has(agentId));
        if (additions.length === 0) {
          return room;
        }
        let nextRoom = syncRoomParticipants(
          room,
          [...room.participants, ...additions.map((agentId, index) => createAgentParticipant(agentId, getAgentParticipants(room).length + index + 1, agentDefinitions))],
        );
        nextRoom = appendMessageToRoom(
          nextRoom,
          createSystemRoomEvent(nextRoom, `${getRoomAgent(actorAgentId, agentDefinitions).label} added ${additions.map((agentId) => getRoomAgent(agentId, agentDefinitions).label).join(", ")} to the room.`),
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
        nextRoom = appendMessageToRoom(nextRoom, createSystemRoomEvent(nextRoom, `${getRoomAgent(actorAgentId, agentDefinitions).label} left the room.`));
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
          createSystemRoomEvent(nextRoom, `${getRoomAgent(actorAgentId, agentDefinitions).label} removed ${removedParticipant.name} from the room.`),
        );
        return nextRoom;
      });
    }
  }

  return nextRooms;
}

export function getRoomPreview(room: RoomSession): string {
  const lastMessage = room.roomMessages[room.roomMessages.length - 1];
  if (!lastMessage) {
    return room.archivedAt ? "Archived room" : "Empty room";
  }
  const preview = formatMessageForTranscript(lastMessage.content, lastMessage.attachments).replace(/\s+/g, " ").trim();
  return preview.length > 56 ? `${preview.slice(0, 56).trim()}...` : preview;
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

export function summarizeToolResult(tools: ToolExecution[]): string {
  const successCount = tools.filter((tool) => tool.status === "success").length;
  return `${tools.length} tools (${successCount} ok)`;
}

export type ApplyCronTurnToWorkspaceArgs = {
  workspace: RoomWorkspaceState;
  agentId: RoomAgentId;
  targetRoomId: string;
  turn: RoomSession["agentTurns"][number];
  resolvedModel: string;
  compatibility: ProviderCompatibility;
  emittedMessages: RoomMessage[];
  receiptUpdates: RoomMessageReceiptUpdate[];
  roomActions: RoomToolActionUnion[];
};
