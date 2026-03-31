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
  const header = `- seq ${message.seq} | messageId ${message.id} | from ${message.sender.name} (${message.sender.id}, ${message.sender.role}) | ${message.kind}/${message.status}`;
  const body = formatMessageForTranscript(message.content, message.attachments)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

  return `${header}\n${body}`;
}

export function buildSchedulerPacketContent(
  room: RoomSession,
  participant: RoomParticipant,
  messages: RoomMessage[],
  options?: {
    hasNewDelta?: boolean;
  },
): string {
  const visibleTargetMessages = getSchedulerVisibleTargetMessages(messages, participant);
  const latestParticipantMessage = visibleTargetMessages[visibleTargetMessages.length - 1] ?? null;
  const visibleMessageLines = visibleTargetMessages.length > 0
    ? visibleTargetMessages.map((message) => formatSchedulerPacketMessage(message))
    : ["- none"];

  return [
    "[Room scheduler sync packet]",
    `Target participant: ${participant.name} (${participant.id})`,
    `Room: ${room.title} (roomId: ${room.id})`,
    options?.hasNewDelta ? "Update type: new visible room activity" : "Update type: scheduler replay / no new seq",
    `Visible unseen message count: ${visibleTargetMessages.length}`,
    latestParticipantMessage
      ? `Latest message: seq ${latestParticipantMessage.seq} | messageId ${latestParticipantMessage.id} | from ${latestParticipantMessage.sender.name} (${latestParticipantMessage.sender.id}, ${latestParticipantMessage.sender.role}) | ${latestParticipantMessage.kind}/${latestParticipantMessage.status}: ${latestParticipantMessage.content}`
      : "Latest message: none",
    "Visible unseen messages:",
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
    buildSchedulerPacketContent(args.room, args.participant, args.messages, {
      hasNewDelta: args.hasNewDelta,
    }),
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
