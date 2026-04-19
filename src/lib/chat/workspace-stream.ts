import type {
  AgentRoomTurn,
  AgentRuntimeState,
  AgentSharedState,
  ChatSettings,
  ProviderCompatibility,
  RoomAgentId,
  RoomMessage,
  RoomParticipant,
  RoomSchedulerState,
  RoomSession,
  WorkspaceRuntimeState,
  RoomWorkspaceState,
} from "@/lib/chat/types";
import { dedupeRoomMessages, sortRoomsForDisplay, upsertMessageToRoom } from "@/lib/chat/workspace-domain";

export interface RoomSessionPatch {
  roomId: string;
  room?: RoomSession;
  title?: string;
  agentId?: RoomAgentId;
  archivedAt?: string | null;
  pinnedAt?: string | null;
  ownerParticipantId?: string | null;
  receiptRevision?: number;
  participants?: RoomParticipant[];
  scheduler?: RoomSchedulerState;
  messageUpserts?: RoomMessage[];
  removedMessageIds?: string[];
  error?: string;
  updatedAt?: string;
}

export interface AgentSharedStatePatch {
  agentId: RoomAgentId;
  state?: AgentSharedState;
  settings?: ChatSettings;
  turnUpserts?: AgentRoomTurn[];
  removedTurnIds?: string[];
  resolvedModel?: string;
  compatibility?: ProviderCompatibility | null;
  updatedAt?: string;
}

export interface WorkspaceStatePatch {
  rooms?: RoomSession[];
  roomPatches?: RoomSessionPatch[];
  removedRoomIds?: string[];
  agentStates?: Partial<Record<RoomAgentId, AgentSharedState>>;
  agentStatePatches?: AgentSharedStatePatch[];
  removedAgentIds?: RoomAgentId[];
  activeRoomId?: string;
  selectedConsoleAgentId?: RoomAgentId | null;
}

export interface WorkspaceRuntimeStatePatch {
  agentStates?: Partial<Record<RoomAgentId, AgentRuntimeState>>;
  removedAgentIds?: RoomAgentId[];
}

export type WorkspaceStreamEvent =
  | {
      type: "snapshot";
      version: number;
      updatedAt: string;
      state: RoomWorkspaceState;
    }
  | {
      type: "patch";
      version: number;
      updatedAt: string;
      patch: WorkspaceStatePatch;
    }
  | {
      type: "runtime-snapshot";
      runtimeVersion: number;
      updatedAt: string;
      state: WorkspaceRuntimeState;
    }
  | {
      type: "runtime-patch";
      runtimeVersion: number;
      updatedAt: string;
      patch: WorkspaceRuntimeStatePatch;
    };

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

function sortTurnsByUserMessageTime(turns: AgentRoomTurn[]): AgentRoomTurn[] {
  return [...turns].sort((left, right) => {
    const leftTime = Date.parse(left.userMessage.createdAt || "");
    const rightTime = Date.parse(right.userMessage.createdAt || "");
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.id.localeCompare(right.id);
  });
}

function upsertTurns(turns: AgentRoomTurn[], upserts: AgentRoomTurn[]): AgentRoomTurn[] {
  const turnsById = new Map(turns.map((turn) => [turn.id, turn]));
  for (const turn of upserts) {
    turnsById.set(turn.id, turn);
  }
  return sortTurnsByUserMessageTime([...turnsById.values()]);
}

function diffRoomMessages(previous: RoomMessage[], next: RoomMessage[]): {
  messageUpserts?: RoomMessage[];
  removedMessageIds?: string[];
} {
  const previousById = new Map(previous.map((message) => [message.id, message]));
  const nextById = new Map(next.map((message) => [message.id, message]));
  const messageUpserts = next.filter((message) => {
    const previousMessage = previousById.get(message.id);
    return !previousMessage || stableStringify(previousMessage) !== stableStringify(message);
  });
  const removedMessageIds = previous.filter((message) => !nextById.has(message.id)).map((message) => message.id);

  return {
    ...(messageUpserts.length > 0 ? { messageUpserts } : {}),
    ...(removedMessageIds.length > 0 ? { removedMessageIds } : {}),
  };
}

function diffAgentTurns(previous: AgentRoomTurn[], next: AgentRoomTurn[]): {
  turnUpserts?: AgentRoomTurn[];
  removedTurnIds?: string[];
} {
  const previousById = new Map(previous.map((turn) => [turn.id, turn]));
  const nextById = new Map(next.map((turn) => [turn.id, turn]));
  const turnUpserts = next.filter((turn) => {
    const previousTurn = previousById.get(turn.id);
    return !previousTurn || stableStringify(previousTurn) !== stableStringify(turn);
  });
  const removedTurnIds = previous.filter((turn) => !nextById.has(turn.id)).map((turn) => turn.id);

  return {
    ...(turnUpserts.length > 0 ? { turnUpserts } : {}),
    ...(removedTurnIds.length > 0 ? { removedTurnIds } : {}),
  };
}

function createRoomSessionPatch(previous: RoomSession, next: RoomSession): RoomSessionPatch | null {
  const messageDiff = diffRoomMessages(previous.roomMessages, next.roomMessages);
  const patch: RoomSessionPatch = {
    roomId: next.id,
    ...(previous.title !== next.title ? { title: next.title } : {}),
    ...(previous.agentId !== next.agentId ? { agentId: next.agentId } : {}),
    ...(previous.archivedAt !== next.archivedAt ? { archivedAt: next.archivedAt } : {}),
    ...(previous.pinnedAt !== next.pinnedAt ? { pinnedAt: next.pinnedAt } : {}),
    ...(previous.ownerParticipantId !== next.ownerParticipantId ? { ownerParticipantId: next.ownerParticipantId } : {}),
    ...(previous.receiptRevision !== next.receiptRevision ? { receiptRevision: next.receiptRevision } : {}),
    ...(stableStringify(previous.participants) !== stableStringify(next.participants) ? { participants: next.participants } : {}),
    ...(stableStringify(previous.scheduler) !== stableStringify(next.scheduler) ? { scheduler: next.scheduler } : {}),
    ...messageDiff,
    ...(previous.error !== next.error ? { error: next.error } : {}),
    ...(previous.updatedAt !== next.updatedAt ? { updatedAt: next.updatedAt } : {}),
  };

  return Object.keys(patch).length > 1 ? patch : null;
}

function createAgentSharedStatePatch(previous: AgentSharedState, next: AgentSharedState, agentId: RoomAgentId): AgentSharedStatePatch | null {
  const turnDiff = diffAgentTurns(previous.agentTurns, next.agentTurns);
  const patch: AgentSharedStatePatch = {
    agentId,
    ...(stableStringify(previous.settings) !== stableStringify(next.settings) ? { settings: next.settings } : {}),
    ...turnDiff,
    ...(previous.resolvedModel !== next.resolvedModel ? { resolvedModel: next.resolvedModel } : {}),
    ...(stableStringify(previous.compatibility) !== stableStringify(next.compatibility) ? { compatibility: next.compatibility } : {}),
    ...(previous.updatedAt !== next.updatedAt ? { updatedAt: next.updatedAt } : {}),
  };

  return Object.keys(patch).length > 1 ? patch : null;
}

export function createWorkspaceStatePatch(previous: RoomWorkspaceState, next: RoomWorkspaceState): WorkspaceStatePatch {
  const previousRooms = new Map(previous.rooms.map((room) => [room.id, room]));
  const nextRooms = new Map(next.rooms.map((room) => [room.id, room]));
  const changedRooms: RoomSession[] = [];
  const roomPatches: RoomSessionPatch[] = [];
  const removedRoomIds: string[] = [];

  for (const room of next.rooms) {
    const previousRoom = previousRooms.get(room.id);
    if (!previousRoom) {
      changedRooms.push(room);
      continue;
    }

    if (stableStringify(previousRoom) === stableStringify(room)) {
      continue;
    }

    const patch = createRoomSessionPatch(previousRoom, room);
    if (patch) {
      roomPatches.push(patch);
    } else {
      changedRooms.push(room);
    }
  }

  for (const roomId of previousRooms.keys()) {
    if (!nextRooms.has(roomId)) {
      removedRoomIds.push(roomId);
    }
  }

  const previousAgentStates = previous.agentStates;
  const nextAgentStates = next.agentStates;
  const changedAgentStates: Partial<Record<RoomAgentId, AgentSharedState>> = {};
  const agentStatePatches: AgentSharedStatePatch[] = [];
  const removedAgentIds: RoomAgentId[] = [];

  for (const [agentId, nextState] of Object.entries(nextAgentStates) as Array<[RoomAgentId, AgentSharedState]>) {
    const previousState = previousAgentStates[agentId];
    if (!previousState) {
      changedAgentStates[agentId] = nextState;
      continue;
    }

    if (stableStringify(previousState) === stableStringify(nextState)) {
      continue;
    }

    const patch = createAgentSharedStatePatch(previousState, nextState, agentId);
    if (patch) {
      agentStatePatches.push(patch);
    } else {
      changedAgentStates[agentId] = nextState;
    }
  }

  for (const agentId of Object.keys(previousAgentStates) as RoomAgentId[]) {
    if (!(agentId in nextAgentStates)) {
      removedAgentIds.push(agentId);
    }
  }

  const patch: WorkspaceStatePatch = {};
  if (changedRooms.length > 0) {
    patch.rooms = changedRooms;
  }
  if (roomPatches.length > 0) {
    patch.roomPatches = roomPatches;
  }
  if (removedRoomIds.length > 0) {
    patch.removedRoomIds = removedRoomIds;
  }
  if (Object.keys(changedAgentStates).length > 0) {
    patch.agentStates = changedAgentStates;
  }
  if (agentStatePatches.length > 0) {
    patch.agentStatePatches = agentStatePatches;
  }
  if (removedAgentIds.length > 0) {
    patch.removedAgentIds = removedAgentIds;
  }
  if (previous.activeRoomId !== next.activeRoomId) {
    patch.activeRoomId = next.activeRoomId;
  }
  if ((previous.selectedConsoleAgentId ?? null) !== (next.selectedConsoleAgentId ?? null)) {
    patch.selectedConsoleAgentId = next.selectedConsoleAgentId ?? null;
  }

  return patch;
}

function applyRoomSessionPatch(room: RoomSession, patch: RoomSessionPatch): RoomSession {
  if (patch.room) {
    return patch.room;
  }

  let nextRoom: RoomSession = {
    ...room,
    ...(typeof patch.title === "string" ? { title: patch.title } : {}),
    ...(typeof patch.agentId === "string" ? { agentId: patch.agentId } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "archivedAt") ? { archivedAt: patch.archivedAt ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "pinnedAt") ? { pinnedAt: patch.pinnedAt ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "ownerParticipantId") ? { ownerParticipantId: patch.ownerParticipantId ?? null } : {}),
    ...(typeof patch.receiptRevision === "number" ? { receiptRevision: patch.receiptRevision } : {}),
    ...(patch.participants ? { participants: patch.participants } : {}),
    ...(patch.scheduler ? { scheduler: patch.scheduler } : {}),
    ...(typeof patch.error === "string" ? { error: patch.error } : {}),
    ...(typeof patch.updatedAt === "string" ? { updatedAt: patch.updatedAt } : {}),
  };

  if (patch.removedMessageIds?.length) {
    nextRoom = {
      ...nextRoom,
      roomMessages: nextRoom.roomMessages.filter((message) => !patch.removedMessageIds?.includes(message.id)),
    };
  }

  for (const message of patch.messageUpserts ?? []) {
    nextRoom = upsertMessageToRoom(nextRoom, message);
  }

  return {
    ...nextRoom,
    roomMessages: dedupeRoomMessages(nextRoom.roomMessages),
  };
}

function applyAgentSharedStatePatch(state: AgentSharedState, patch: AgentSharedStatePatch): AgentSharedState {
  if (patch.state) {
    return patch.state;
  }

  let nextTurns = state.agentTurns;
  if (patch.removedTurnIds?.length) {
    nextTurns = nextTurns.filter((turn) => !patch.removedTurnIds?.includes(turn.id));
  }
  if (patch.turnUpserts?.length) {
    nextTurns = upsertTurns(nextTurns, patch.turnUpserts);
  }

  return {
    ...state,
    ...(patch.settings ? { settings: patch.settings } : {}),
    agentTurns: nextTurns,
    ...(typeof patch.resolvedModel === "string" ? { resolvedModel: patch.resolvedModel } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "compatibility") ? { compatibility: patch.compatibility ?? null } : {}),
    ...(typeof patch.updatedAt === "string" ? { updatedAt: patch.updatedAt } : {}),
  };
}

export function applyWorkspaceStatePatch(state: RoomWorkspaceState, patch: WorkspaceStatePatch): RoomWorkspaceState {
  let nextRooms = state.rooms;
  if (patch.rooms || patch.roomPatches || patch.removedRoomIds) {
    const roomsById = new Map(state.rooms.map((room) => [room.id, room]));
    for (const roomId of patch.removedRoomIds ?? []) {
      roomsById.delete(roomId);
    }
    for (const roomPatch of patch.roomPatches ?? []) {
      const currentRoom = roomsById.get(roomPatch.roomId);
      if (currentRoom) {
        roomsById.set(roomPatch.roomId, applyRoomSessionPatch(currentRoom, roomPatch));
      } else if (roomPatch.room) {
        roomsById.set(roomPatch.room.id, roomPatch.room);
      }
    }
    for (const room of patch.rooms ?? []) {
      roomsById.set(room.id, room);
    }
    nextRooms = sortRoomsForDisplay([...roomsById.values()]);
  }

  let nextAgentStates = state.agentStates;
  if (patch.agentStates || patch.agentStatePatches || patch.removedAgentIds) {
    nextAgentStates = { ...state.agentStates };
    for (const agentId of patch.removedAgentIds ?? []) {
      delete nextAgentStates[agentId];
    }
    for (const agentPatch of patch.agentStatePatches ?? []) {
      const currentState = nextAgentStates[agentPatch.agentId];
      if (currentState) {
        nextAgentStates[agentPatch.agentId] = applyAgentSharedStatePatch(currentState, agentPatch);
      } else if (agentPatch.state) {
        nextAgentStates[agentPatch.agentId] = agentPatch.state;
      }
    }
    for (const [agentId, agentState] of Object.entries(patch.agentStates ?? {}) as Array<[RoomAgentId, AgentSharedState]>) {
      nextAgentStates[agentId] = agentState;
    }
  }

  return {
    rooms: nextRooms,
    agentStates: nextAgentStates,
    activeRoomId: patch.activeRoomId ?? state.activeRoomId,
    ...(Object.prototype.hasOwnProperty.call(patch, "selectedConsoleAgentId")
      ? {
          selectedConsoleAgentId: patch.selectedConsoleAgentId ?? undefined,
        }
      : Object.prototype.hasOwnProperty.call(state, "selectedConsoleAgentId")
        ? {
            selectedConsoleAgentId: state.selectedConsoleAgentId,
          }
        : {}),
  };
}

export function createWorkspaceRuntimeStatePatch(previous: WorkspaceRuntimeState, next: WorkspaceRuntimeState): WorkspaceRuntimeStatePatch {
  const patch: WorkspaceRuntimeStatePatch = {};
  const changedAgentStates: Partial<Record<RoomAgentId, AgentRuntimeState>> = {};
  const removedAgentIds: RoomAgentId[] = [];

  for (const [agentId, nextState] of Object.entries(next.agentStates) as Array<[RoomAgentId, AgentRuntimeState]>) {
    const previousState = previous.agentStates[agentId];
    if (!previousState || stableStringify(previousState) !== stableStringify(nextState)) {
      changedAgentStates[agentId] = nextState;
    }
  }

  for (const agentId of Object.keys(previous.agentStates) as RoomAgentId[]) {
    if (!(agentId in next.agentStates)) {
      removedAgentIds.push(agentId);
    }
  }

  if (Object.keys(changedAgentStates).length > 0) {
    patch.agentStates = changedAgentStates;
  }

  if (removedAgentIds.length > 0) {
    patch.removedAgentIds = removedAgentIds;
  }

  return patch;
}

export function applyWorkspaceRuntimeStatePatch(state: WorkspaceRuntimeState, patch: WorkspaceRuntimeStatePatch): WorkspaceRuntimeState {
  if (!patch.agentStates && !patch.removedAgentIds?.length) {
    return state;
  }

  const nextAgentStates = { ...state.agentStates };
  for (const agentId of patch.removedAgentIds ?? []) {
    delete nextAgentStates[agentId];
  }

  for (const [agentId, agentState] of Object.entries(patch.agentStates ?? {}) as Array<[RoomAgentId, AgentRuntimeState]>) {
    nextAgentStates[agentId] = agentState;
  }

  return {
    agentStates: nextAgentStates,
  };
}
