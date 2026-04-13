import type { RoomMessage, RoomParticipant, RoomSession } from "@/lib/chat/types";
import { getNextAgentParticipant, getSchedulerVisibleTargetMessages } from "@/lib/chat/room-scheduler";
import { getEnabledAgentParticipants } from "@/lib/chat/workspace-domain";

export type SchedulerRoundPlan =
  | {
      type: "idle";
    }
  | {
      type: "participant";
      participant: RoomParticipant & { agentId?: string };
      enabledAgentCount: number;
      nextAfterParticipantId: string;
      cutoffSeq: number;
      unseenMessages: RoomMessage[];
      visibleTargetMessages: RoomMessage[];
      anchorMessageId?: string;
    };

export function planSchedulerRound(room: RoomSession): SchedulerRoundPlan {
  const participant = getNextAgentParticipant(room);
  const enabledAgents = getEnabledAgentParticipants(room);
  if (!participant || enabledAgents.length === 0 || room.archivedAt) {
    return { type: "idle" };
  }

  const nextAfterParticipant = getNextAgentParticipant(room, participant.id);
  const cutoffSeq = room.roomMessages[room.roomMessages.length - 1]?.seq ?? 0;
  const lastCursor = room.scheduler.agentCursorByParticipantId[participant.id] ?? 0;
  const unseenMessages = room.roomMessages.filter(
    (message) => message.seq > lastCursor && message.seq <= cutoffSeq && message.sender.id !== participant.id,
  );
  const enabledAgentIds = new Set(enabledAgents.map((entry) => entry.id));
  const hasHumanTrigger = unseenMessages.some(
    (message) => message.sender.role === "participant" && !enabledAgentIds.has(message.sender.id),
  );
  const hasInitialOwnerAgentTrigger = lastCursor <= 0 && unseenMessages.some(
    (message) => message.sender.role === "participant" && message.sender.id === room.ownerParticipantId && enabledAgentIds.has(message.sender.id),
  );
  const hasOwnerSynthesisTrigger = participant.id === room.ownerParticipantId && unseenMessages.some(
    (message) => message.sender.role === "participant"
      && enabledAgentIds.has(message.sender.id)
      && message.sender.id !== room.ownerParticipantId,
  );
  const visibleTargetMessages = hasHumanTrigger || hasInitialOwnerAgentTrigger || hasOwnerSynthesisTrigger
    ? getSchedulerVisibleTargetMessages(unseenMessages, participant)
    : [];

  return {
    type: "participant",
    participant,
    enabledAgentCount: enabledAgents.length,
    nextAfterParticipantId: nextAfterParticipant?.id ?? participant.id,
    cutoffSeq,
    unseenMessages,
    visibleTargetMessages,
    ...(visibleTargetMessages[visibleTargetMessages.length - 1]?.id
      ? { anchorMessageId: visibleTargetMessages[visibleTargetMessages.length - 1]?.id }
      : {}),
  };
}

export function hasSupersedingVisibleActivity(room: RoomSession, participantId: string, cutoffSeq: number): boolean {
  return room.roomMessages.some((message) => message.seq > cutoffSeq && message.sender.id !== participantId);
}
