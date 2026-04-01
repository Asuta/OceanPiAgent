import type { MessageImageAttachment, RoomAgentDefinition, RoomAgentId, RoomParticipant, RoomSession } from "@/lib/chat/types";
import {
  appendMessageToRoom,
  createAgentParticipant,
  createHumanParticipant,
  createRoomMessage,
  createSystemRoomEvent,
  createTimestamp,
  getAgentParticipants,
  getHumanParticipants,
  getNextRoomMessageSeq,
  getPrimaryRoomAgentId,
  getRoomAgent,
  syncRoomParticipants,
} from "@/lib/chat/workspace-domain";

function getParticipantSender(participant: RoomParticipant) {
  return {
    id: participant.id,
    name: participant.name,
    role: participant.senderRole,
  } as const;
}

export function resolveRoomMessageSender(args: {
  room: RoomSession;
  senderId?: string;
  defaultLocalParticipantId: string;
  defaultLocalParticipantName: string;
}): RoomParticipant | null {
  const humanParticipants = getHumanParticipants(args.room);
  return (
    humanParticipants.find((participant) => participant.id === args.senderId)
    ?? (args.senderId === args.defaultLocalParticipantId
      ? createHumanParticipant(args.defaultLocalParticipantName, args.defaultLocalParticipantId)
      : null)
    ?? humanParticipants[0]
  );
}

export function getSuggestedRoomTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.length > 30 ? `${normalized.slice(0, 30).trim()}...` : normalized;
}

export function shouldAutoTitleRoom(room: RoomSession): boolean {
  return /^Room \d+$/.test(room.title) && room.roomMessages.length === 0 && room.agentTurns.length === 0;
}

export function applyOutgoingUserMessage(args: {
  room: RoomSession;
  content: string;
  attachments?: MessageImageAttachment[];
  sender: RoomParticipant;
  nextTitle: string;
}): RoomSession {
  const roomUserMessage = createRoomMessage(args.room.id, "user", args.content, "user", {
    seq: getNextRoomMessageSeq(args.room),
    sender: getParticipantSender(args.sender),
    attachments: args.attachments ?? [],
    kind: "user_input",
    status: "completed",
    final: true,
  });

  const roomWithHumanMembership =
    args.sender.runtimeKind === "human" && !args.room.participants.some((participant) => participant.id === args.sender.id)
      ? syncRoomParticipants(args.room, [...args.room.participants, createHumanParticipant(args.sender.name, args.sender.id)])
      : args.room;
  const nextRoom = appendMessageToRoom(
    {
      ...roomWithHumanMembership,
      title: args.nextTitle,
      error: "",
    },
    roomUserMessage,
  );

  return {
    ...nextRoom,
    agentId: getPrimaryRoomAgentId(nextRoom),
  };
}

export function addHumanParticipantToRoom(args: {
  room: RoomSession;
  name: string;
  createParticipantId: (prefix: string) => string;
}): RoomSession {
  let nextRoom = syncRoomParticipants(args.room, [
    ...args.room.participants,
    createHumanParticipant(args.name, args.createParticipantId("human")),
  ]);
  nextRoom = appendMessageToRoom(nextRoom, createSystemRoomEvent(nextRoom, `You added ${args.name} to the room.`));
  return nextRoom;
}

export function addAgentParticipantToRoom(args: {
  room: RoomSession;
  agentId: RoomAgentId;
  agentDefinitions?: RoomAgentDefinition[];
}): RoomSession {
  if (args.room.participants.some((participant) => participant.runtimeKind === "agent" && participant.agentId === args.agentId)) {
    return args.room;
  }

  let nextRoom = syncRoomParticipants(args.room, [
    ...args.room.participants,
    createAgentParticipant(args.agentId, getAgentParticipants(args.room).length + 1, args.agentDefinitions),
  ]);
  nextRoom = appendMessageToRoom(nextRoom, createSystemRoomEvent(nextRoom, `You added ${getRoomAgent(args.agentId, args.agentDefinitions).label} to the room.`));
  return nextRoom;
}

export function removeParticipantFromRoom(args: {
  room: RoomSession;
  participantId: string;
}): RoomSession {
  const removedParticipant = args.room.participants.find((participant) => participant.id === args.participantId);
  const nextParticipants = args.room.participants.filter((participant) => participant.id !== args.participantId);
  if (nextParticipants.length === args.room.participants.length) {
    return args.room;
  }

  let nextRoom = syncRoomParticipants(args.room, nextParticipants);
  nextRoom = appendMessageToRoom(
    nextRoom,
    createSystemRoomEvent(nextRoom, `You removed ${removedParticipant?.name || args.participantId} from the room.`),
  );
  return nextRoom;
}

export function toggleAgentParticipantInRoom(args: {
  room: RoomSession;
  participantId: string;
}): RoomSession {
  return syncRoomParticipants(
    args.room,
    args.room.participants.map((participant) =>
      participant.id === args.participantId && participant.runtimeKind === "agent"
        ? {
            ...participant,
            enabled: !participant.enabled,
            updatedAt: createTimestamp(),
          }
        : participant,
    ),
  );
}

export function moveAgentParticipantInRoom(args: {
  room: RoomSession;
  participantId: string;
  direction: -1 | 1;
}): RoomSession {
  const agents = getAgentParticipants(args.room);
  const agentIndex = agents.findIndex((participant) => participant.id === args.participantId);
  const targetIndex = agentIndex + args.direction;
  if (agentIndex < 0 || targetIndex < 0 || targetIndex >= agents.length) {
    return args.room;
  }

  const reorderedAgents = [...agents];
  const [movedAgent] = reorderedAgents.splice(agentIndex, 1);
  reorderedAgents.splice(targetIndex, 0, movedAgent);
  const reorderedById = new Map(reorderedAgents.map((participant, index) => [participant.id, index + 1]));

  return syncRoomParticipants(
    args.room,
    args.room.participants.map((participant) =>
      participant.runtimeKind === "agent"
        ? {
            ...participant,
            order: reorderedById.get(participant.id) ?? participant.order,
            updatedAt: createTimestamp(),
          }
        : participant,
    ),
  );
}
