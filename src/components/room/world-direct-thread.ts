import type { RoomThreadDraftEntry, RoomThreadToolEntry } from "@/components/workspace/room-thread";
import type { RoomMessage } from "@/lib/chat/types";

export type WorldDirectThreadEntry =
  | {
      kind: "message";
      id: string;
      message: RoomMessage;
    }
  | {
      kind: "tool";
      id: string;
      entry: RoomThreadToolEntry;
    }
  | {
      kind: "draft";
      id: string;
      entry: RoomThreadDraftEntry;
    };

function getSortableTime(value: string) {
  const timestamp = Date.parse(value || "");
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function sortRoomMessages(messages: RoomMessage[]) {
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

export function buildWorldDirectThreadTimeline(args: {
  roomMessages: RoomMessage[];
  toolEntriesByAnchor: Map<string, RoomThreadToolEntry[]>;
  draftEntriesByAnchor: Map<string, RoomThreadDraftEntry[]>;
}): WorldDirectThreadEntry[] {
  const timeline: WorldDirectThreadEntry[] = [];

  for (const message of sortRoomMessages(args.roomMessages)) {
    timeline.push({
      kind: "message",
      id: message.id,
      message,
    });

    const anchoredArtifacts = [
      ...(args.toolEntriesByAnchor.get(message.id) ?? []).map((entry) => ({
        kind: "tool" as const,
        id: entry.id,
        sequence: entry.event.sequence,
        entry,
      })),
      ...(args.draftEntriesByAnchor.get(message.id) ?? []).map((entry) => ({
        kind: "draft" as const,
        id: entry.id,
        sequence: entry.event.sequence,
        entry,
      })),
    ].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));

    for (const artifact of anchoredArtifacts) {
      timeline.push(
        artifact.kind === "tool"
          ? {
              kind: "tool",
              id: artifact.id,
              entry: artifact.entry,
            }
          : {
              kind: "draft",
              id: artifact.id,
              entry: artifact.entry,
            },
      );
    }
  }

  return timeline;
}
