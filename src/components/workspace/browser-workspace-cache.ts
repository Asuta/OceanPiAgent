import type {
  AgentRoomTurn,
  AgentSharedState,
  AssistantMessageMeta,
  DraftTextSegment,
  RoomSession,
  RoomAgentId,
  RoomMessage,
  RoomWorkspaceState,
  ToolExecution,
  TurnTimelineEvent,
} from "@/lib/chat/types";
import { dedupeRoomMessages } from "@/lib/chat/workspace-domain";

const BROWSER_CACHE_VERSION = 1;
const MAX_ROOM_MESSAGES_PER_ROOM = 250;
const MAX_AGENT_TURNS_PER_AGENT = 80;
const MAX_TOOLS_PER_TURN = 40;
const MAX_EMITTED_MESSAGES_PER_TURN = 40;
const MAX_TIMELINE_EVENTS_PER_TURN = 120;
const MAX_DRAFT_SEGMENTS_PER_TURN = 32;
const MAX_MESSAGE_CONTENT_LENGTH = 16_000;
const MAX_ASSISTANT_CONTENT_LENGTH = 24_000;
const MAX_DRAFT_CONTENT_LENGTH = 6_000;
const MAX_TOOL_SUMMARY_LENGTH = 4_000;
const TRUNCATION_MARKER = "\n...[browser cache truncated]...\n";

export interface WorkspaceBootstrap {
  version: typeof BROWSER_CACHE_VERSION;
  activeRoomId: string;
  selectedConsoleAgentId?: RoomAgentId;
  savedAt: string;
}

export interface BrowserWorkspaceCacheRecord {
  key: "workspace";
  version: typeof BROWSER_CACHE_VERSION;
  updatedAt: string;
  state: RoomWorkspaceState;
}

function hasSupersetIds<T extends { id: string }>(candidate: T[], baseline: T[]): boolean {
  const candidateIds = new Set(candidate.map((item) => item.id));
  return baseline.every((item) => candidateIds.has(item.id));
}

function getSortableTime(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function mergeTurnsKeepingOrder(serverTurns: AgentRoomTurn[], cachedTurns: AgentRoomTurn[]): AgentRoomTurn[] {
  const turnsById = new Map(serverTurns.map((turn) => [turn.id, turn]));
  for (const turn of cachedTurns) {
    turnsById.set(turn.id, turn);
  }

  const cachedTurnIds = new Set(cachedTurns.map((turn) => turn.id));
  const merged = [
    ...cachedTurns,
    ...serverTurns.filter((turn) => !cachedTurnIds.has(turn.id)),
  ];

  return merged.map((turn) => turnsById.get(turn.id) ?? turn);
}

function takeRecent<T>(items: T[], limit: number): T[] {
  return items.length > limit ? items.slice(items.length - limit) : [...items];
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const remainingLength = Math.max(0, maxLength - TRUNCATION_MARKER.length);
  const leadingLength = Math.ceil(remainingLength / 2);
  const trailingLength = Math.floor(remainingLength / 2);
  return `${value.slice(0, leadingLength)}${TRUNCATION_MARKER}${value.slice(value.length - trailingLength)}`;
}

function sanitizeRoomMessage(message: RoomMessage): RoomMessage {
  return {
    ...message,
    content: truncateText(message.content, MAX_MESSAGE_CONTENT_LENGTH),
  };
}

function sanitizeToolExecution(tool: ToolExecution): ToolExecution {
  return {
    ...tool,
    inputSummary: truncateText(tool.inputSummary || tool.inputText, MAX_TOOL_SUMMARY_LENGTH),
    inputText: "",
    resultPreview: truncateText(tool.resultPreview || tool.outputText, MAX_TOOL_SUMMARY_LENGTH),
    outputText: "",
  };
}

function sanitizeDraftSegment(segment: DraftTextSegment): DraftTextSegment {
  return {
    ...segment,
    content: truncateText(segment.content, MAX_DRAFT_CONTENT_LENGTH),
  };
}

function sanitizeTimelineEvent(event: TurnTimelineEvent): TurnTimelineEvent {
  return { ...event };
}

function sanitizeAssistantMessageMeta(meta: AssistantMessageMeta | undefined): AssistantMessageMeta | undefined {
  if (!meta) {
    return undefined;
  }

  const sanitizedMeta: AssistantMessageMeta = {
    apiFormat: meta.apiFormat,
    compatibility: meta.compatibility,
  };

  if (meta.responseId) {
    sanitizedMeta.responseId = meta.responseId;
  }
  if (meta.sessionId) {
    sanitizedMeta.sessionId = meta.sessionId;
  }
  if (meta.continuation) {
    sanitizedMeta.continuation = { ...meta.continuation };
  }
  if (meta.usage) {
    sanitizedMeta.usage = { ...meta.usage };
  }

  return sanitizedMeta;
}

function sanitizeAgentTurn(turn: AgentRoomTurn): AgentRoomTurn {
  return {
    ...turn,
    continuationSnapshot: undefined,
    assistantContent: truncateText(turn.assistantContent, MAX_ASSISTANT_CONTENT_LENGTH),
    userMessage: sanitizeRoomMessage(turn.userMessage),
    draftSegments: turn.draftSegments
      ? takeRecent(turn.draftSegments, MAX_DRAFT_SEGMENTS_PER_TURN).map(sanitizeDraftSegment)
      : undefined,
    timeline: turn.timeline
      ? takeRecent(turn.timeline, MAX_TIMELINE_EVENTS_PER_TURN).map(sanitizeTimelineEvent)
      : undefined,
    tools: takeRecent(turn.tools, MAX_TOOLS_PER_TURN).map(sanitizeToolExecution),
    emittedMessages: takeRecent(turn.emittedMessages, MAX_EMITTED_MESSAGES_PER_TURN).map(sanitizeRoomMessage),
    meta: sanitizeAssistantMessageMeta(turn.meta),
  };
}

function sanitizeAgentState(state: AgentSharedState): AgentSharedState {
  return {
    ...state,
    agentTurns: takeRecent(state.agentTurns, MAX_AGENT_TURNS_PER_AGENT).map(sanitizeAgentTurn),
  };
}

export function buildWorkspaceBootstrapState(state: Pick<RoomWorkspaceState, "activeRoomId" | "selectedConsoleAgentId">): WorkspaceBootstrap {
  return {
    version: BROWSER_CACHE_VERSION,
    activeRoomId: state.activeRoomId,
    ...(state.selectedConsoleAgentId ? { selectedConsoleAgentId: state.selectedConsoleAgentId } : {}),
    savedAt: new Date().toISOString(),
  };
}

export function applyWorkspaceBootstrapToSnapshot(
  snapshot: RoomWorkspaceState,
  bootstrap: WorkspaceBootstrap | null,
): RoomWorkspaceState {
  if (!bootstrap) {
    return snapshot;
  }

  const nextActiveRoomId = snapshot.rooms.some((room) => room.id === bootstrap.activeRoomId)
    ? bootstrap.activeRoomId
    : snapshot.activeRoomId;
  const nextSelectedConsoleAgentId = bootstrap.selectedConsoleAgentId && snapshot.agentStates[bootstrap.selectedConsoleAgentId]
    ? bootstrap.selectedConsoleAgentId
    : snapshot.selectedConsoleAgentId;

  if (nextActiveRoomId === snapshot.activeRoomId && nextSelectedConsoleAgentId === snapshot.selectedConsoleAgentId) {
    return snapshot;
  }

  return {
    ...snapshot,
    activeRoomId: nextActiveRoomId,
    ...(nextSelectedConsoleAgentId ? { selectedConsoleAgentId: nextSelectedConsoleAgentId } : {}),
  };
}

export function buildBrowserWorkspaceCacheState(state: RoomWorkspaceState): RoomWorkspaceState {
  return {
    rooms: state.rooms.map((room) => ({
      ...room,
      roomMessages: takeRecent(room.roomMessages, MAX_ROOM_MESSAGES_PER_ROOM).map(sanitizeRoomMessage),
      agentTurns: [],
    })),
    agentStates: Object.fromEntries(
      Object.entries(state.agentStates).map(([agentId, agentState]) => [agentId, sanitizeAgentState(agentState)]),
    ) as Record<RoomAgentId, AgentSharedState>,
    activeRoomId: state.activeRoomId,
    ...(state.selectedConsoleAgentId ? { selectedConsoleAgentId: state.selectedConsoleAgentId } : {}),
  };
}

export function buildBrowserWorkspaceCacheRecord(state: RoomWorkspaceState): BrowserWorkspaceCacheRecord {
  return {
    key: "workspace",
    version: BROWSER_CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    state: buildBrowserWorkspaceCacheState(state),
  };
}

export function mergeBrowserWorkspaceIntoSnapshot(
  serverSnapshot: RoomWorkspaceState,
  browserSnapshot: RoomWorkspaceState | null,
): RoomWorkspaceState {
  if (!browserSnapshot) {
    return serverSnapshot;
  }

  const browserRoomsById = new Map(browserSnapshot.rooms.map((room) => [room.id, room]));
  const mergedRooms = serverSnapshot.rooms.map((room) => {
    const browserRoom = browserRoomsById.get(room.id);
    if (!browserRoom) {
      return room;
    }

    const mergedRoomMessages = browserRoom.roomMessages.length > room.roomMessages.length && hasSupersetIds(browserRoom.roomMessages, room.roomMessages)
      ? dedupeRoomMessages(browserRoom.roomMessages)
      : room.roomMessages;

    return {
      ...room,
      roomMessages: mergedRoomMessages,
    };
  });

  const mergedAgentStates = Object.fromEntries(
    Object.entries(serverSnapshot.agentStates).map(([agentId, agentState]) => {
      const browserAgentState = browserSnapshot.agentStates[agentId as RoomAgentId];
      if (!browserAgentState) {
        return [agentId, agentState];
      }

      const mergedAgentTurns = browserAgentState.agentTurns.length > agentState.agentTurns.length
        && hasSupersetIds(browserAgentState.agentTurns, agentState.agentTurns)
        ? mergeTurnsKeepingOrder(agentState.agentTurns, browserAgentState.agentTurns)
        : agentState.agentTurns;

      return [
        agentId,
        {
          ...agentState,
          agentTurns: mergedAgentTurns,
        },
      ];
    }),
  ) as Record<RoomAgentId, AgentSharedState>;

  return {
    ...serverSnapshot,
    rooms: mergedRooms,
    agentStates: mergedAgentStates,
  };
}

function mergeCrossTabRoom(baseRoom: RoomSession, browserRoom: RoomSession): RoomSession {
  const browserUpdatedAt = getSortableTime(browserRoom.updatedAt);
  const baseUpdatedAt = getSortableTime(baseRoom.updatedAt);
  const browserMessages = dedupeRoomMessages(browserRoom.roomMessages);
  const shouldUseBrowserMessages = browserUpdatedAt > baseUpdatedAt
    || (browserMessages.length >= baseRoom.roomMessages.length && hasSupersetIds(browserMessages, baseRoom.roomMessages));

  if (browserUpdatedAt <= baseUpdatedAt && !shouldUseBrowserMessages) {
    return baseRoom;
  }

  return {
    ...baseRoom,
    ...(browserUpdatedAt > baseUpdatedAt ? browserRoom : {}),
    agentTurns: baseRoom.agentTurns,
    roomMessages: shouldUseBrowserMessages ? browserMessages : baseRoom.roomMessages,
  };
}

function mergeCrossTabAgentState(baseState: AgentSharedState, browserState: AgentSharedState): AgentSharedState {
  const browserUpdatedAt = getSortableTime(browserState.updatedAt);
  const baseUpdatedAt = getSortableTime(baseState.updatedAt);
  const browserTurnsAreSuperset = hasSupersetIds(browserState.agentTurns, baseState.agentTurns);
  const shouldUseBrowserState = browserUpdatedAt > baseUpdatedAt
    || (browserTurnsAreSuperset && browserState.agentTurns.length >= baseState.agentTurns.length);

  return shouldUseBrowserState ? browserState : baseState;
}

export function mergeCrossTabBrowserWorkspaceIntoSnapshot(
  currentSnapshot: RoomWorkspaceState,
  browserSnapshot: RoomWorkspaceState | null,
): RoomWorkspaceState {
  if (!browserSnapshot) {
    return currentSnapshot;
  }

  const browserRoomsById = new Map(browserSnapshot.rooms.map((room) => [room.id, room]));
  let roomsChanged = false;
  const mergedRooms = currentSnapshot.rooms.map((room) => {
    const browserRoom = browserRoomsById.get(room.id);
    if (!browserRoom) {
      return room;
    }

    const mergedRoom = mergeCrossTabRoom(room, browserRoom);
    if (mergedRoom !== room) {
      roomsChanged = true;
    }
    return mergedRoom;
  });

  let agentStatesChanged = false;
  const mergedAgentStates = { ...currentSnapshot.agentStates };

  for (const [agentId, state] of Object.entries(currentSnapshot.agentStates) as [RoomAgentId, AgentSharedState][]) {
    const browserState = browserSnapshot.agentStates[agentId];
    if (!browserState) {
      continue;
    }

    const mergedState = mergeCrossTabAgentState(state, browserState);
    if (mergedState !== state) {
      mergedAgentStates[agentId] = mergedState;
      agentStatesChanged = true;
    }
  }

  if (!roomsChanged && !agentStatesChanged) {
    return currentSnapshot;
  }

  return {
    ...currentSnapshot,
    rooms: mergedRooms,
    agentStates: mergedAgentStates,
  };
}
