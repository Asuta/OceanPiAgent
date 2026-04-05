import type { DraftTextSegment, RoomMessage, ToolExecution, TurnTimelineEvent } from "@/lib/chat/types";
import { createUuid } from "@/lib/utils/uuid";

function createDraftSegmentTimelineEvent(segment: DraftTextSegment): TurnTimelineEvent {
  return {
    id: `draft-segment:${segment.id}`,
    sequence: segment.sequence,
    type: "draft-segment",
    segmentId: segment.id,
  };
}

function createRoomMessageTimelineEvent(message: RoomMessage, sequence: number): TurnTimelineEvent {
  return {
    id: `room-message:${message.id}`,
    sequence,
    type: "room-message",
    messageId: message.id,
    roomId: message.roomId,
  };
}

function mergeEmittedMessages(messages: RoomMessage[], message: RoomMessage): RoomMessage[] {
  const existingIndex = messages.findIndex((entry) => entry.id === message.id);
  if (existingIndex < 0) {
    return [...messages, message];
  }

  const nextMessages = [...messages];
  nextMessages[existingIndex] = {
    ...nextMessages[existingIndex],
    ...message,
    id: nextMessages[existingIndex].id,
    roomId: nextMessages[existingIndex].roomId,
    seq: nextMessages[existingIndex].seq,
    role: nextMessages[existingIndex].role,
    sender: nextMessages[existingIndex].sender,
    source: nextMessages[existingIndex].source,
    createdAt: nextMessages[existingIndex].createdAt,
  };
  return nextMessages;
}

export function createToolTimelineEvent(tool: ToolExecution, sequence: number): TurnTimelineEvent {
  return {
    id: `tool:${tool.id}`,
    sequence,
    type: "tool",
    toolId: tool.id,
  };
}

export function upsertEmittedRoomMessageState(
  emittedMessages: RoomMessage[],
  timeline: TurnTimelineEvent[],
  roomMessage: RoomMessage,
): void {
  const alreadySeenMessage = emittedMessages.some((entry) => entry.id === roomMessage.id);
  emittedMessages.splice(0, emittedMessages.length, ...mergeEmittedMessages(emittedMessages, roomMessage));
  if (!alreadySeenMessage) {
    timeline.push(createRoomMessageTimelineEvent(roomMessage, timeline.length + 1));
  }
}

export function appendDraftDelta(args: {
  draftSegments: DraftTextSegment[];
  timeline: TurnTimelineEvent[];
  delta: string;
}): { draftSegments: DraftTextSegment[]; timeline: TurnTimelineEvent[] } {
  const lastSegment = args.draftSegments[args.draftSegments.length - 1];
  if (lastSegment && lastSegment.status === "streaming") {
    const nextDraftSegments = [...args.draftSegments];
    nextDraftSegments[nextDraftSegments.length - 1] = {
      ...lastSegment,
      content: `${lastSegment.content}${args.delta}`,
    };
    return {
      draftSegments: nextDraftSegments,
      timeline: args.timeline,
    };
  }

  const segment: DraftTextSegment = {
    id: createUuid(),
    sequence: args.timeline.length + 1,
    content: args.delta,
    status: "streaming",
  };
  return {
    draftSegments: [...args.draftSegments, segment],
    timeline: [...args.timeline, createDraftSegmentTimelineEvent(segment)],
  };
}

export function finalizeLatestDraftSegment(draftSegments: DraftTextSegment[]): DraftTextSegment[] {
  const lastSegment = draftSegments[draftSegments.length - 1];
  if (!lastSegment || lastSegment.status !== "streaming") {
    return draftSegments;
  }

  const nextDraftSegments = [...draftSegments];
  nextDraftSegments[nextDraftSegments.length - 1] = {
    ...lastSegment,
    status: "completed",
  };
  return nextDraftSegments;
}
