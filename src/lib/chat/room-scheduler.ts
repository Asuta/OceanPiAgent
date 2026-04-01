import { formatMessageForTranscript } from "@/lib/chat/message-attachments";
import type { MessageImageAttachment, RoomAgentId, RoomMessage, RoomParticipant, RoomSender, RoomSession } from "@/lib/chat/types";
import { createRoomMessage, getEnabledAgentParticipants } from "@/lib/chat/workspace-domain";

export interface ActiveSchedulerRun {
  cycleId: string;
  activeAgentId: RoomAgentId | null;
  activeRequestId: string | null;
}

export const ROOM_SCHEDULER_SENDER: RoomSender = {
  id: "room-scheduler",
  name: "Room Scheduler",
  role: "system",
};

export function getNextAgentParticipant(room: RoomSession, currentParticipantId?: string | null): RoomParticipant | null {
  const enabledAgents = getEnabledAgentParticipants(room);
  if (enabledAgents.length === 0) {
    return null;
  }

  if (currentParticipantId) {
    const currentIndex = enabledAgents.findIndex((participant) => participant.id === currentParticipantId);
    if (currentIndex >= 0) {
      return enabledAgents[(currentIndex + 1) % enabledAgents.length];
    }
  }

  if (room.scheduler.nextAgentParticipantId) {
    const scheduled = enabledAgents.find((participant) => participant.id === room.scheduler.nextAgentParticipantId);
    if (scheduled) {
      return scheduled;
    }
  }

  return enabledAgents[0];
}

export function getSchedulerVisibleTargetMessages(messages: RoomMessage[], participant: RoomParticipant): RoomMessage[] {
  return messages.filter((message) => message.sender.role === "participant" && message.sender.id !== participant.id);
}

function collectSchedulerPacketAttachments(messages: RoomMessage[]): MessageImageAttachment[] {
  const seenIds = new Set<string>();
  const attachments: MessageImageAttachment[] = [];

  for (const message of messages) {
    for (const attachment of message.attachments) {
      if (seenIds.has(attachment.id)) {
        continue;
      }
      seenIds.add(attachment.id);
      attachments.push(attachment);
    }
  }

  return attachments;
}

function formatSchedulerPacketMessage(message: RoomMessage): string {
  const body = formatMessageForTranscript(message.content, message.attachments).replace(/\s+/g, " ").trim();
  return `- ${message.sender.name}: ${body || "(empty)"}`;
}

export function buildSchedulerPacketContent(
  participant: RoomParticipant,
  messages: RoomMessage[],
): string {
  const visibleTargetMessages = getSchedulerVisibleTargetMessages(messages, participant);
  const latestParticipantMessage = visibleTargetMessages[visibleTargetMessages.length - 1] ?? null;
  const visibleMessageLines = visibleTargetMessages.length > 0
    ? visibleTargetMessages.map((message) => formatSchedulerPacketMessage(message))
    : ["- none"];

  return [
    "[Room scheduler sync packet]",
    latestParticipantMessage
      ? `Latest messageId: ${latestParticipantMessage.id}`
      : "Latest messageId: none",
    "Unseen messages:",
    ...visibleMessageLines,
  ].join("\n");
}

export function roomHasRunningAgent(room: RoomSession, activeSchedulerRun?: ActiveSchedulerRun | null): boolean {
  return room.scheduler.status === "running" || Boolean(activeSchedulerRun?.activeAgentId);
}

export function shouldAutoRestartSchedulerForMessage(
  room: RoomSession,
  message: RoomMessage,
  activeSchedulerRun?: ActiveSchedulerRun | null,
): boolean {
  if (room.archivedAt) {
    return false;
  }

  if (room.scheduler.status === "running" || activeSchedulerRun?.activeAgentId) {
    return false;
  }

  if (message.sender.role !== "participant") {
    return false;
  }

  return getEnabledAgentParticipants(room).some((participant) => participant.id !== message.sender.id);
}

export function createSchedulerPacket(args: {
  room: RoomSession;
  participant: RoomParticipant;
  messages: RoomMessage[];
  requestId: string;
  hasNewDelta: boolean;
}): RoomMessage {
  const visibleTargetMessages = getSchedulerVisibleTargetMessages(args.messages, args.participant);
  const packet = createRoomMessage(
    args.room.id,
    "system",
    buildSchedulerPacketContent(args.participant, args.messages),
    "system",
    {
      attachments: collectSchedulerPacketAttachments(visibleTargetMessages),
      sender: ROOM_SCHEDULER_SENDER,
      kind: "system",
      status: "completed",
      final: true,
    },
  );
  packet.id = args.requestId;
  return packet;
}
