import { useMemo } from "react";
import { getHumanParticipants, getPrimaryRoomAgentId } from "@/components/workspace-provider";
import { buildRoomThreadDraftEntries, buildRoomThreadToolEntries, type RoomThreadDraftEntry, type RoomThreadToolEntry } from "@/components/workspace/room-thread";
import type { AgentRoomTurn, AgentSharedState, MessageImageAttachment, RoomAgentId, RoomParticipant, RoomSession } from "@/lib/chat/types";

const DEFAULT_LOCAL_PARTICIPANT_ID = "local-operator";
const LOCAL_PARTICIPANT_NAME = "You";

function getTurnRoomId(turn: { userMessage: { roomId: string }; emittedMessages: Array<{ roomId: string }> }) {
  return turn.userMessage.roomId || turn.emittedMessages[0]?.roomId || "";
}

function getSortableTime(value: string) {
  const timestamp = Date.parse(value || "");
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function dedupeTurnsById(turns: AgentRoomTurn[]): AgentRoomTurn[] {
  const turnMap = new Map<string, AgentRoomTurn>();
  for (const turn of turns) {
    turnMap.set(turn.id, turn);
  }
  return [...turnMap.values()];
}

export function useRoomDetailState(args: {
  roomId: string;
  room: RoomSession | null;
  rooms: RoomSession[];
  agentStates: Record<RoomAgentId, AgentSharedState>;
  draftsByRoomId: Record<string, string>;
  selectedConsoleAgentId: RoomAgentId | null;
  selectedSenderByRoomId: Record<string, string>;
  pendingAttachments: MessageImageAttachment[];
  isUploadingImages: boolean;
  titleDraftByRoomId: Record<string, string>;
  consoleScope: "room" | "all" | "timeline";
}) {
  const latestMessage = args.room?.roomMessages.at(-1) ?? null;
  const roomThreadToolEntries = useMemo<Map<string, RoomThreadToolEntry[]>>(
    () =>
      args.room
        ? buildRoomThreadToolEntries({
            roomId: args.room.id,
            roomMessages: args.room.roomMessages,
            agentStates: args.agentStates,
          })
        : new Map<string, RoomThreadToolEntry[]>(),
    [args.agentStates, args.room],
  );
  const roomThreadDraftEntries = useMemo<Map<string, RoomThreadDraftEntry[]>>(
    () =>
      args.room
        ? buildRoomThreadDraftEntries({
            roomId: args.room.id,
            roomMessages: args.room.roomMessages,
            agentStates: args.agentStates,
          })
        : new Map<string, RoomThreadDraftEntry[]>(),
    [args.agentStates, args.room],
  );
  const visibleInlineTools = useMemo(() => Array.from(roomThreadToolEntries.values()).flat(), [roomThreadToolEntries]);
  const visibleInlineDrafts = useMemo(() => Array.from(roomThreadDraftEntries.values()).flat(), [roomThreadDraftEntries]);
  const latestInlineTool = visibleInlineTools.at(-1) ?? null;
  const latestInlineDraft = visibleInlineDrafts.at(-1) ?? null;
  const threadScrollKey = args.room
    ? `${args.room.roomMessages.length}:${latestMessage?.id ?? ""}:${latestMessage?.status ?? ""}:${latestMessage?.content.length ?? 0}:${latestMessage?.attachments.length ?? 0}:${visibleInlineTools.length}:${latestInlineTool?.turn.id ?? ""}:${latestInlineTool?.tool.id ?? ""}:${latestInlineTool?.event.sequence ?? 0}:${visibleInlineDrafts.length}:${latestInlineDraft?.turn.id ?? ""}:${latestInlineDraft?.turn.status ?? ""}:${latestInlineDraft?.turn.assistantContent.length ?? 0}`
    : "";

  const roomDraft = args.room ? args.draftsByRoomId[args.room.id] ?? "" : "";
  const humanParticipants = useMemo(() => (args.room ? getHumanParticipants(args.room) : []), [args.room]);
  const availableSenders = useMemo<RoomParticipant[]>(() => {
    if (!args.room) {
      return [];
    }

    const hasLocalParticipant = humanParticipants.some((participant) => participant.id === DEFAULT_LOCAL_PARTICIPANT_ID);
    if (hasLocalParticipant) {
      return humanParticipants;
    }

    return [
      {
        id: DEFAULT_LOCAL_PARTICIPANT_ID,
        name: LOCAL_PARTICIPANT_NAME,
        senderRole: "participant",
        runtimeKind: "human",
        enabled: true,
        order: 0,
        createdAt: args.room.createdAt,
        updatedAt: args.room.updatedAt,
      },
      ...humanParticipants,
    ];
  }, [humanParticipants, args.room]);
  const selectedSenderId = args.room ? args.selectedSenderByRoomId[args.room.id] : undefined;
  const selectedSender = availableSenders.find((participant) => participant.id === selectedSenderId) ?? availableSenders[0] ?? null;
  const primaryAgentId = args.room ? getPrimaryRoomAgentId(args.room) : "concierge";
  const consoleAgentId = (args.selectedConsoleAgentId ?? primaryAgentId) as RoomAgentId;
  const consoleAgentState = args.agentStates[consoleAgentId];
  const titleDraft = args.room ? args.titleDraftByRoomId[args.room.id] ?? args.room.title : "";
  const activeParticipant = args.room
    ? args.room.participants.find((participant) => participant.id === args.room?.scheduler.activeParticipantId) ?? null
    : null;
  const ownerParticipant = args.room
    ? args.room.participants.find((participant) => participant.id === args.room?.ownerParticipantId) ?? null
    : null;
  const localParticipantMissing = args.room ? !args.room.participants.some((participant) => participant.id === DEFAULT_LOCAL_PARTICIPANT_ID) : false;
  const canSend = Boolean((roomDraft.trim() || args.pendingAttachments.length > 0) && selectedSender && !args.isUploadingImages);
  const currentRoomId = args.room?.id ?? args.roomId;
  const currentRoomTitle = args.room?.title ?? "Unknown room";
  const roomTitleById = useMemo(() => new Map(args.rooms.map((entry) => [entry.id, entry.title])), [args.rooms]);
  const roomTurns = useMemo(
    () => {
      const room = args.room;
      return room
        ? (consoleAgentState?.agentTurns ?? []).filter(
            (turn) => turn.userMessage.roomId === room.id || turn.emittedMessages.some((message) => message.roomId === room.id),
          )
        : [];
    },
    [consoleAgentState?.agentTurns, args.room],
  );
  const roomTurnStats = useMemo(() => {
    return roomTurns.reduce(
      (stats, turn) => {
        stats.turns += 1;
        stats.tools += turn.tools.length;
        stats.emissions += turn.emittedMessages.length;
        return stats;
      },
      { turns: 0, tools: 0, emissions: 0 },
    );
  }, [roomTurns]);
  const visibleConsoleTurns = useMemo(() => {
    const turns = args.consoleScope === "room" ? roomTurns : (consoleAgentState?.agentTurns ?? []);
    return [...dedupeTurnsById(turns)].sort((left, right) => getSortableTime(left.userMessage.createdAt) - getSortableTime(right.userMessage.createdAt));
  }, [args.consoleScope, consoleAgentState?.agentTurns, roomTurns]);
  const consoleTurnGroups = useMemo(() => {
    if (!args.room) {
      return [] as Array<{ roomId: string; roomTitle: string; turns: typeof visibleConsoleTurns }>;
    }

    if (args.consoleScope === "timeline") {
      return [
        {
          roomId: "timeline",
          roomTitle: "执行顺序",
          turns: visibleConsoleTurns,
        },
      ];
    }

    const groups = new Map<string, { roomId: string; roomTitle: string; turns: typeof visibleConsoleTurns }>();
    for (const turn of visibleConsoleTurns) {
      const turnRoomId = getTurnRoomId(turn) || args.room.id;
      const existing = groups.get(turnRoomId);
      if (existing) {
        existing.turns.push(turn);
        continue;
      }

      groups.set(turnRoomId, {
        roomId: turnRoomId,
        roomTitle: roomTitleById.get(turnRoomId) ?? (turnRoomId === args.room.id ? args.room.title : "Unknown room"),
        turns: [turn],
      });
    }

    return Array.from(groups.values()).sort((left, right) => {
      const leftTime = getSortableTime(left.turns[left.turns.length - 1]?.userMessage.createdAt ?? "");
      const rightTime = getSortableTime(right.turns[right.turns.length - 1]?.userMessage.createdAt ?? "");
      return rightTime - leftTime;
    });
  }, [args.consoleScope, args.room, roomTitleById, visibleConsoleTurns]);

  return {
    latestMessage,
    roomThreadToolEntries,
    roomThreadDraftEntries,
    visibleInlineTools,
    visibleInlineDrafts,
    threadScrollKey,
    roomDraft,
    humanParticipants,
    availableSenders,
    selectedSender,
    primaryAgentId,
    consoleAgentId,
    consoleAgentState,
    titleDraft,
    activeParticipant,
    ownerParticipant,
    localParticipantMissing,
    canSend,
    currentRoomId,
    currentRoomTitle,
    roomTitleById,
    roomTurns,
    roomTurnStats,
    visibleConsoleTurns,
    consoleTurnGroups,
  };
}
