"use client";

import { createPixelOfficeLayout, type AgentWorldPoint, type WorldZone, type WorldZoneId } from "@/components/workspace/agent-world-layout";
import type { PathfindingWorld } from "@/components/workspace/agent-world-pathfinding";
import { getRoomAgent } from "@/lib/chat/workspace-domain";
import type { AgentRoomTurn, AgentSharedState, RoomAgentDefinition, RoomAgentId, RoomMessage, RoomSession, WorkspaceRuntimeState } from "@/lib/chat/types";

export type AgentWorldStatus = "resting" | "working";
export type { AgentWorldPoint, WorldZone, WorldZoneId } from "@/components/workspace/agent-world-layout";

export interface WorldEventPulse {
  kind: "chat" | "work";
  label: string;
  expiresAt: string;
}

export interface AgentWorldModel {
  agentId: RoomAgentId;
  label: string;
  summary: string;
  status: AgentWorldStatus;
  statusLabel: string;
  isOnline: boolean;
  isCurrentRoomParticipant: boolean;
  roomTitles: string[];
  desk: AgentWorldPoint;
  target: AgentWorldPoint;
  targetZone: WorldZoneId;
  pulse: WorldEventPulse | null;
  lastActiveAt: string | null;
  resolvedModel: string | null;
  recentToolName: string | null;
  recentMessage: string | null;
  colorSeed: number;
  movementDurationMs: number;
}

export interface AgentWorldSnapshot {
  agents: AgentWorldModel[];
  zones: WorldZone[];
  world: PathfindingWorld;
  generatedAt: string;
}

const STATUS_LABELS: Record<AgentWorldStatus, string> = {
  resting: "休息中",
  working: "工作中",
};

const REST_WANDER_INTERVAL_MS = 5_000;
const WORK_FINISH_GRACE_MS = 20_000;
const CHAT_BUBBLE_TTL_MS = 7_000;
const WORK_BUBBLE_TTL_MS = 5_500;
const REST_TRAVEL_DURATION_MS = 5_000;
const WORK_TRAVEL_DURATION_MS = 2_000;

function getSortableTime(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function isFresh(value: string | null | undefined, now: number, ttlMs: number): boolean {
  const timestamp = getSortableTime(value);
  return timestamp > 0 && now - timestamp <= ttlMs;
}

function truncateText(value: string | null | undefined, maxLength: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1)}…`;
}

function getTurnActivityTime(turn: AgentRoomTurn): number {
  return Math.max(
    getSortableTime(turn.userMessage.createdAt),
    ...turn.emittedMessages.map((message) => getSortableTime(message.createdAt)),
  );
}

function getLatestTurn(turns: AgentRoomTurn[]): AgentRoomTurn | null {
  return [...turns].sort((left, right) => getTurnActivityTime(right) - getTurnActivityTime(left))[0] ?? null;
}

function getLatestMessage(messages: RoomMessage[]): RoomMessage | null {
  return [...messages].sort((left, right) => getSortableTime(right.createdAt) - getSortableTime(left.createdAt))[0] ?? null;
}

function getLatestToolTurn(turns: AgentRoomTurn[]): AgentRoomTurn | null {
  return [...turns]
    .filter((turn) => turn.tools.length > 0)
    .sort((left, right) => getTurnActivityTime(right) - getTurnActivityTime(left))[0] ?? null;
}

function getRecentToolCompletion(turns: AgentRoomTurn[]): { at: string | null; toolName: string | null } {
  const latestToolTurn = getLatestToolTurn(turns);
  if (!latestToolTurn) {
    return { at: null, toolName: null };
  }

  return {
    at: latestToolTurn.emittedMessages.at(-1)?.createdAt ?? latestToolTurn.userMessage.createdAt,
    toolName: latestToolTurn.tools.at(-1)?.displayName ?? null,
  };
}

function getLatestChatPulse(turns: AgentRoomTurn[]): { at: string | null; message: string | null } {
  const latestTurn = getLatestTurn(turns);
  const latestMessage = getLatestMessage(latestTurn?.emittedMessages ?? []);
  if (!latestMessage) {
    return { at: null, message: null };
  }

  return {
    at: latestMessage.createdAt,
    message: truncateText(latestMessage.content, 36),
  };
}

function createRestTarget(index: number, now: number, waypoints: AgentWorldPoint[]): AgentWorldPoint {
  const step = Math.floor(now / REST_WANDER_INTERVAL_MS);
  const waypoint = waypoints[(index + step) % waypoints.length] ?? waypoints[0]!;
  const jitterPhase = (index * 19 + step * 7) % 5;
  const jitterX = (jitterPhase - 2) * 1.2;
  const jitterY = (((index * 11 + step * 5) % 5) - 2) * 1.1;

  return {
    x: waypoint.x + jitterX,
    y: waypoint.y + jitterY,
    label: "Lounge",
  };
}

export function buildAgentWorldSnapshot(args: {
  agents: RoomAgentDefinition[];
  rooms: RoomSession[];
  agentStates: Record<RoomAgentId, AgentSharedState>;
  runtimeState?: WorkspaceRuntimeState;
  currentRoomId?: string;
  now?: number;
}): AgentWorldSnapshot {
  const now = args.now ?? Date.now();
  const activeRooms = args.rooms.filter((room) => !room.archivedAt);
  const agentIds = new Set<RoomAgentId>([
    ...args.agents.map((agent) => agent.id),
    ...(Object.keys(args.agentStates) as RoomAgentId[]),
    ...activeRooms.flatMap((room) =>
      room.participants.filter((participant) => participant.runtimeKind === "agent" && participant.agentId).map((participant) => participant.agentId as RoomAgentId),
    ),
  ]);

  const sortedAgentIds = [...agentIds]
    .sort((left, right) => getRoomAgent(left, args.agents).label.localeCompare(getRoomAgent(right, args.agents).label));
  const layout = createPixelOfficeLayout(sortedAgentIds.length);

  const agents = sortedAgentIds
    .map((agentId, index) => {
      const definition = getRoomAgent(agentId, args.agents);
      const state = args.agentStates[agentId];
      const turns = state?.agentTurns ?? [];
      const relatedRooms = activeRooms.filter((room) => room.participants.some((participant) => participant.runtimeKind === "agent" && participant.agentId === agentId));
      const latestTurn = getLatestTurn(turns);
      const recentToolCompletion = getRecentToolCompletion(turns);
      const latestChatPulse = getLatestChatPulse(turns);
      const runtimeEntry = args.runtimeState?.agentStates[agentId];
      const toolCompletionIsFresh = isFresh(recentToolCompletion.at, now, WORK_FINISH_GRACE_MS);
      const isWorking = Boolean(runtimeEntry) || toolCompletionIsFresh;
      const deskLayout = layout.desks[index];
      const desk = deskLayout?.desk ?? { x: 62, y: 34, label: `Desk ${index + 1}` };
      const target = isWorking ? (deskLayout?.workstation ?? desk) : createRestTarget(index, now, layout.loungeWaypoints);
      const status: AgentWorldStatus = isWorking ? "working" : "resting";
      const hasFreshChatPulse = isFresh(latestChatPulse.at, now, CHAT_BUBBLE_TTL_MS);

      let pulse: WorldEventPulse | null = null;
      if (hasFreshChatPulse) {
        pulse = {
          kind: "chat",
          label: latestChatPulse.message || "聊两句",
          expiresAt: latestChatPulse.at || new Date(now + CHAT_BUBBLE_TTL_MS).toISOString(),
        };
      } else if (isWorking) {
        pulse = {
          kind: "work",
          label: runtimeEntry?.toolName || recentToolCompletion.toolName || "正在用电脑",
          expiresAt: new Date(now + WORK_BUBBLE_TTL_MS).toISOString(),
        };
      }

      const lastActiveAt = [
        latestTurn?.emittedMessages.at(-1)?.createdAt ?? null,
        latestTurn?.userMessage.createdAt ?? null,
        runtimeEntry?.updatedAt ?? null,
        state?.updatedAt ?? null,
      ]
        .sort((left, right) => getSortableTime(right) - getSortableTime(left))[0] ?? null;

      return {
        agentId,
        label: definition.label,
        summary: definition.summary,
        status,
        statusLabel: STATUS_LABELS[status],
        isOnline: relatedRooms.some((room) =>
          room.participants.some((participant) => participant.runtimeKind === "agent" && participant.agentId === agentId && participant.enabled),
        ),
        isCurrentRoomParticipant: relatedRooms.some((room) => room.id === args.currentRoomId),
        roomTitles: relatedRooms.map((room) => room.title),
        desk,
        target,
        targetZone: isWorking ? "workspace" : "lounge",
        pulse,
        lastActiveAt,
        resolvedModel: state?.resolvedModel || null,
        recentToolName: runtimeEntry?.toolName ?? recentToolCompletion.toolName,
        recentMessage: latestChatPulse.message,
        colorSeed: index,
        movementDurationMs: status === "working" ? WORK_TRAVEL_DURATION_MS : REST_TRAVEL_DURATION_MS,
      } satisfies AgentWorldModel;
    });

  return {
    agents,
    zones: layout.zones,
    world: layout.world,
    generatedAt: new Date(now).toISOString(),
  };
}
