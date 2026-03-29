import type { AgentRoomTurn, AgentSharedState, RoomAgentId, RoomMessage, ToolExecution, TurnTimelineEvent } from "@/lib/chat/types";

export interface RoomThreadToolEntry {
  id: string;
  turn: AgentRoomTurn;
  tool: ToolExecution;
  anchorMessageId: string;
  event: Extract<TurnTimelineEvent, { type: "tool" }>;
  isLatestForAnchor: boolean;
}

export interface RoomThreadDraftEntry {
  id: string;
  turn: AgentRoomTurn;
  anchorMessageId: string;
  segment: NonNullable<AgentRoomTurn["draftSegments"]>[number];
  event: Extract<TurnTimelineEvent, { type: "draft-segment" }>;
}

function getSortableTime(value: string) {
  const timestamp = Date.parse(value || "");
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function sortRoomMessages(messages: RoomMessage[]): RoomMessage[] {
  return [...messages].sort((left, right) => {
    const leftSeq = left.seq || 0;
    const rightSeq = right.seq || 0;
    if (leftSeq !== rightSeq) {
      return leftSeq - rightSeq;
    }

    const leftTime = getSortableTime(left.createdAt);
    const rightTime = getSortableTime(right.createdAt);
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.id.localeCompare(right.id);
  });
}

function sortTurnTimeline(events: TurnTimelineEvent[]): TurnTimelineEvent[] {
  return [...events].sort((left, right) => left.sequence - right.sequence);
}

function getDraftSegmentsForTurn(turn: AgentRoomTurn): NonNullable<AgentRoomTurn["draftSegments"]> {
  if (turn.draftSegments && turn.draftSegments.length > 0) {
    return turn.draftSegments;
  }

  if (!turn.assistantContent.trim()) {
    return [];
  }

  return [
    {
      id: `${turn.id}-legacy-draft`,
      sequence: 1,
      content: turn.assistantContent,
      status: turn.status === "running" || turn.status === "continued" ? "streaming" : "completed",
    },
  ];
}

function createFallbackTimeline(turn: AgentRoomTurn): TurnTimelineEvent[] {
  const timeline: TurnTimelineEvent[] = [];

  for (const segment of getDraftSegmentsForTurn(turn)) {
    timeline.push({
      id: `draft-segment:${segment.id}`,
      sequence: segment.sequence,
      type: "draft-segment",
      segmentId: segment.id,
    });
  }

  for (const tool of turn.tools) {
    timeline.push({
      id: `tool:${tool.id}`,
      sequence: tool.sequence,
      type: "tool",
      toolId: tool.id,
    });
  }

  for (const message of sortRoomMessages(turn.emittedMessages)) {
    timeline.push({
      id: `room-message:${message.id}`,
      sequence: message.seq || timeline.length + 1,
      type: "room-message",
      messageId: message.id,
      roomId: message.roomId,
    });
  }

  return sortTurnTimeline(timeline);
}

function getLegacySchedulerAnchorMessageId(turn: AgentRoomTurn): string | undefined {
  if (turn.userMessage.sender.id !== "room-scheduler") {
    return undefined;
  }

  const match = turn.userMessage.content.match(/messageId\s+([^\s|]+)/);
  return match?.[1];
}

export function getRoomTurnsForTimeline(args: {
  roomId: string;
  agentStates: Record<RoomAgentId, AgentSharedState>;
}): AgentRoomTurn[] {
  const turnsById = new Map<string, AgentRoomTurn>();

  for (const state of Object.values(args.agentStates)) {
    for (const turn of state.agentTurns) {
      const relatesToRoom = turn.userMessage.roomId === args.roomId || turn.emittedMessages.some((message) => message.roomId === args.roomId);
      if (!relatesToRoom) {
        continue;
      }

      turnsById.set(turn.id, turn);
    }
  }

  return [...turnsById.values()].sort((left, right) => {
    const leftTime = getSortableTime(left.userMessage.createdAt);
    const rightTime = getSortableTime(right.userMessage.createdAt);
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.id.localeCompare(right.id);
  });
}

export function buildRoomThreadToolEntries(args: {
  roomId: string;
  roomMessages: RoomMessage[];
  agentStates: Record<RoomAgentId, AgentSharedState>;
}): Map<string, RoomThreadToolEntry[]> {
  const messageIds = new Set(args.roomMessages.map((message) => message.id));
  const groupedEntries = new Map<string, RoomThreadToolEntry[]>();

  for (const turn of getRoomTurnsForTimeline({ roomId: args.roomId, agentStates: args.agentStates })) {
    const timeline = turn.timeline && turn.timeline.length > 0 ? sortTurnTimeline(turn.timeline) : createFallbackTimeline(turn);
    if (timeline.length === 0) {
      continue;
    }

    const toolsById = new Map(turn.tools.map((tool) => [tool.id, tool]));
    let currentAnchorMessageId = turn.anchorMessageId ?? getLegacySchedulerAnchorMessageId(turn) ?? turn.userMessage.id;
    if (!messageIds.has(currentAnchorMessageId)) {
      continue;
    }

    for (const event of timeline) {
      if (event.type === "room-message") {
        if (event.roomId === args.roomId && messageIds.has(event.messageId)) {
          currentAnchorMessageId = event.messageId;
        }
        continue;
      }

      if (event.type !== "tool") {
        continue;
      }

      const tool = toolsById.get(event.toolId);
      if (!tool || !messageIds.has(currentAnchorMessageId)) {
        continue;
      }

      const toolEntry: RoomThreadToolEntry = {
        id: `${turn.id}:${event.id}`,
        turn,
        tool,
        anchorMessageId: currentAnchorMessageId,
        event,
        isLatestForAnchor: false,
      };

      const existing = groupedEntries.get(currentAnchorMessageId);
      if (existing) {
        existing.push(toolEntry);
      } else {
        groupedEntries.set(currentAnchorMessageId, [toolEntry]);
      }
    }
  }

  for (const [anchorMessageId, entries] of groupedEntries) {
    const sortedEntries = [...entries].sort((left, right) => {
      if (left.event.sequence !== right.event.sequence) {
        return left.event.sequence - right.event.sequence;
      }

      const leftTime = getSortableTime(left.turn.userMessage.createdAt);
      const rightTime = getSortableTime(right.turn.userMessage.createdAt);
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }

      return left.id.localeCompare(right.id);
    });

    groupedEntries.set(
      anchorMessageId,
      sortedEntries.map((entry, index) => ({
        ...entry,
        isLatestForAnchor: index === sortedEntries.length - 1,
      })),
    );
  }

  return groupedEntries;
}

export function buildRoomThreadDraftEntries(args: {
  roomId: string;
  roomMessages: RoomMessage[];
  agentStates: Record<RoomAgentId, AgentSharedState>;
}): Map<string, RoomThreadDraftEntry[]> {
  const messageIds = new Set(args.roomMessages.map((message) => message.id));
  const groupedEntries = new Map<string, RoomThreadDraftEntry[]>();

  for (const turn of getRoomTurnsForTimeline({ roomId: args.roomId, agentStates: args.agentStates })) {
    const timeline = turn.timeline && turn.timeline.length > 0 ? sortTurnTimeline(turn.timeline) : createFallbackTimeline(turn);
    const draftSegmentsById = new Map(getDraftSegmentsForTurn(turn).map((segment) => [segment.id, segment]));
    if (timeline.length === 0 || draftSegmentsById.size === 0) {
      continue;
    }

    let currentAnchorMessageId = turn.anchorMessageId ?? getLegacySchedulerAnchorMessageId(turn) ?? turn.userMessage.id;
    if (!messageIds.has(currentAnchorMessageId)) {
      continue;
    }

    for (const event of timeline) {
      if (event.type === "room-message") {
        if (event.roomId === args.roomId && messageIds.has(event.messageId)) {
          currentAnchorMessageId = event.messageId;
        }
        continue;
      }

      if (event.type !== "draft-segment") {
        continue;
      }

      const segment = draftSegmentsById.get(event.segmentId);
      if (!segment || (!segment.content.trim() && segment.status !== "streaming") || !messageIds.has(currentAnchorMessageId)) {
        continue;
      }

      const entry: RoomThreadDraftEntry = {
        id: `${turn.id}:${event.id}`,
        turn,
        anchorMessageId: currentAnchorMessageId,
        segment,
        event,
      };
      const existing = groupedEntries.get(currentAnchorMessageId);
      if (existing) {
        existing.push(entry);
      } else {
        groupedEntries.set(currentAnchorMessageId, [entry]);
      }
    }
  }

  for (const [anchorMessageId, entries] of groupedEntries) {
    groupedEntries.set(
      anchorMessageId,
      [...entries].sort((left, right) => {
        if (left.event.sequence !== right.event.sequence) {
          return left.event.sequence - right.event.sequence;
        }
        const leftTime = getSortableTime(left.turn.userMessage.createdAt);
        const rightTime = getSortableTime(right.turn.userMessage.createdAt);
        if (leftTime !== rightTime) {
          return leftTime - rightTime;
        }
        return left.id.localeCompare(right.id);
      }),
    );
  }

  return groupedEntries;
}
