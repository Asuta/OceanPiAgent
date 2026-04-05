import type { AgentRoomTurn } from "@/lib/chat/types";
import { createUuid } from "@/lib/utils/uuid";

export function sortAgentTurnsByUserMessageTime(turns: AgentRoomTurn[]): AgentRoomTurn[] {
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

export function mergeAgentTurns(...turnGroups: AgentRoomTurn[][]): AgentRoomTurn[] {
  const turnsById = new Map<string, AgentRoomTurn>();

  for (const turns of turnGroups) {
    for (const turn of turns) {
      turnsById.set(turn.id, turn);
    }
  }

  return sortAgentTurnsByUserMessageTime([...turnsById.values()]);
}

export function dedupeAgentTurns(turns: AgentRoomTurn[]): AgentRoomTurn[] {
  return mergeAgentTurns(turns);
}

export function appendTimelineEvent(turn: AgentRoomTurn, event: NonNullable<AgentRoomTurn["timeline"]>[number]): AgentRoomTurn {
  if ((turn.timeline ?? []).some((entry) => entry.id === event.id)) {
    return turn;
  }

  return {
    ...turn,
    timeline: [...(turn.timeline ?? []), event],
  };
}

export function appendDraftDelta(turn: AgentRoomTurn, delta: string): AgentRoomTurn {
  const draftSegments = turn.draftSegments ?? [];
  const lastSegment = draftSegments[draftSegments.length - 1];
  if (lastSegment && lastSegment.status === "streaming") {
    const nextDraftSegments = [...draftSegments];
    nextDraftSegments[nextDraftSegments.length - 1] = {
      ...lastSegment,
      content: `${lastSegment.content}${delta}`,
    };
    return {
      ...turn,
      assistantContent: `${turn.assistantContent}${delta}`,
      draftSegments: nextDraftSegments,
    };
  }

  const segment = {
    id: createUuid(),
    sequence: (turn.timeline?.length ?? 0) + 1,
    content: delta,
    status: "streaming" as const,
  };
  return {
    ...appendTimelineEvent(turn, {
      id: `draft-segment:${segment.id}`,
      sequence: segment.sequence,
      type: "draft-segment",
      segmentId: segment.id,
    }),
    assistantContent: `${turn.assistantContent}${delta}`,
    draftSegments: [...draftSegments, segment],
  };
}

export function finalizeLatestDraftSegment(turn: AgentRoomTurn): AgentRoomTurn {
  const draftSegments = turn.draftSegments ?? [];
  const lastSegment = draftSegments[draftSegments.length - 1];
  if (!lastSegment || lastSegment.status !== "streaming") {
    return turn;
  }

  const nextDraftSegments = [...draftSegments];
  nextDraftSegments[nextDraftSegments.length - 1] = {
    ...lastSegment,
    status: "completed",
  };
  return {
    ...turn,
    draftSegments: nextDraftSegments,
  };
}
