import { z } from "zod";
import {
  addAgentsToRoomArgsSchema,
  appendVisibleHistoryMessage,
  applyReadNoReplyToHistory,
  assertRoomOwner,
  assertWritableRoom,
  buildAutoRoomTitle,
  createRoomArgsSchema,
  createRoomMessageResult,
  createStructuredOutput,
  emptyArgsSchema,
  getAttachedRoom,
  getKnownAgent,
  getRoomOwnerName,
  getRoomToolContext,
  getRoomHistoryArgsSchema,
  leaveRoomArgsSchema,
  mutateAddAgentsContext,
  mutateCreateRoomContext,
  mutateLeaveRoomContext,
  mutateRemoveParticipantContext,
  readNoReplyArgsSchema,
  removeRoomParticipantArgsSchema,
  roomMessageArgsSchema,
  uniqueAgentIds,
  type ToolDefinition,
} from "./shared";
import { createUuid } from "@/lib/utils/uuid";

export const roomTools = {
  send_message_to_room: {
    name: "send_message_to_room",
    displayName: "Send Message To Room",
    description:
      "Send a structured user-visible message into a specific attached Chat Room. Use this for both direct replies in the current room and relays, notifications, handoffs, or cross-room messaging into another attached room. You must target an attached roomId and use kind, status, and final to describe the delivery.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        roomId: { type: "string", description: "The target attached Chat Room id that should receive this visible message." },
        content: { type: "string", description: "The exact message that should be delivered into the target Chat Room." },
        kind: {
          type: "string",
          enum: ["answer", "progress", "warning", "error", "clarification"],
          description: "Semantic message type for the room layer.",
        },
        status: {
          type: "string",
          enum: ["pending", "streaming", "completed", "failed"],
          description: "Delivery or completion state for this room message.",
        },
        final: {
          type: "boolean",
          description: "Whether this visible room message is final for the current turn or subtask.",
        },
      },
      required: ["roomId", "content"],
    },
    validate: (value: unknown) => roomMessageArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof roomMessageArgsSchema>;
      const roomContext = getRoomToolContext(context);
      const room = getAttachedRoom(roomContext, args.roomId);
      assertWritableRoom(room);
      if (roomContext.currentAgentId) {
        const currentAgent = getKnownAgent(roomContext, roomContext.currentAgentId);
        appendVisibleHistoryMessage(roomContext, args.roomId, {
          senderId: currentAgent.agentId,
          senderName: currentAgent.label,
          senderRole: "participant",
          role: "assistant",
          source: "agent_emit",
          kind: args.kind,
          status: args.status,
          final: args.final,
          content: args.content,
          attachments: [],
        });
      }
      return createRoomMessageResult(args);
    },
  } satisfies ToolDefinition<unknown>,
  read_no_reply: {
    name: "read_no_reply",
    displayName: "Read No Reply",
    description:
      "Mark a specific participant message as seen without sending a visible room message. You must target an attached roomId and a participant messageId, and do not combine it with a visible room message in that same room outcome.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        roomId: { type: "string", description: "The attached Chat Room id containing the participant message you want to mark as seen." },
        messageId: { type: "string", description: "The participant message id that should receive the read-no-reply marker." },
      },
      required: ["roomId", "messageId"],
    },
    validate: (value: unknown) => readNoReplyArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof readNoReplyArgsSchema>;
      const roomContext = getRoomToolContext(context);
      const room = getAttachedRoom(roomContext, args.roomId);
      assertWritableRoom(room);
      const roomHistory = roomContext.roomHistoryById[args.roomId] ?? [];
      if (!roomHistory.some((message) => message.messageId === args.messageId)) {
        throw new Error(`Message ${args.messageId} was not found in attached room ${args.roomId}.`);
      }

      applyReadNoReplyToHistory(roomContext, args.roomId, args.messageId);
      return {
        output: "Marked the current room message as seen without sending a visible room message.",
        roomAction: {
          type: "read_no_reply",
          roomId: args.roomId,
          messageId: args.messageId,
        },
      };
    },
  } satisfies ToolDefinition<unknown>,
  list_attached_rooms: {
    name: "list_attached_rooms",
    displayName: "List Attached Rooms",
    description:
      "List only the Chat Rooms that are currently attached to this agent. Use this when you need to know which groups you are already part of, along with their owner and member summaries.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    validate: (value: unknown) => emptyArgsSchema.parse(value),
    execute: async (_value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const roomContext = getRoomToolContext(context);
      return createStructuredOutput({
        attachedRooms: roomContext.attachedRooms.map((room) => ({
          roomId: room.id,
          title: room.title,
          archived: room.archived,
          ownerParticipantId: room.ownerParticipantId,
          ownerName: getRoomOwnerName(room),
          currentAgentMembershipRole: room.currentAgentMembershipRole,
          currentAgentIsOwner: room.currentAgentIsOwner,
          participantCount: room.participants.length,
          messageCount: room.messageCount,
          latestMessageAt: room.latestMessageAt,
          participants: room.participants,
        })),
      });
    },
  } satisfies ToolDefinition<unknown>,
  list_known_agents: {
    name: "list_known_agents",
    displayName: "List Known Agents",
    description:
      "Return the current agent phonebook. Each known agent includes an info card with id, label, summary, skills, and workingStyle so you can decide whom to contact or invite.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    validate: (value: unknown) => emptyArgsSchema.parse(value),
    execute: async (_value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const roomContext = getRoomToolContext(context);
      return createStructuredOutput({
        agents: roomContext.knownAgents.map((agent) => ({
          ...agent,
          isCurrentAgent: roomContext.currentAgentId === agent.agentId,
        })),
      });
    },
  } satisfies ToolDefinition<unknown>,
  create_room: {
    name: "create_room",
    displayName: "Create Room",
    description:
      "Create a new room, automatically make the current agent the owner, and optionally include additional agent members. If title is omitted, the room is auto-named from the participating agents. After creating the room, you can send follow-up messages to the returned roomId.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Optional room title. If omitted, the room title is generated from the participating agent labels." },
        agentIds: {
          type: "array",
          items: { type: "string", enum: ["concierge", "researcher", "operator"] },
          description: "Optional list of additional agent ids to include in the new room. The current agent is always included automatically.",
        },
      },
    },
    validate: (value: unknown) => createRoomArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof createRoomArgsSchema>;
      const roomContext = getRoomToolContext(context);
      if (!roomContext.currentAgentId) {
        throw new Error("The current agent id is missing, so a new room cannot be created.");
      }

      const agentIds = uniqueAgentIds([roomContext.currentAgentId, ...args.agentIds]);
      const title = args.title ?? buildAutoRoomTitle(agentIds, roomContext);
      const action = {
        type: "create_room",
        roomId: createUuid(),
        title,
        agentIds,
      } satisfies Extract<Parameters<typeof mutateCreateRoomContext>[1], { type: "create_room" }>;
      mutateCreateRoomContext(roomContext, action);

      return createStructuredOutput(
        {
          roomId: action.roomId,
          title: action.title,
          ownerParticipantId: roomContext.currentAgentId,
          ownerName: getKnownAgent(roomContext, roomContext.currentAgentId).label,
          agentIds: action.agentIds,
        },
        action,
      );
    },
  } satisfies ToolDefinition<unknown>,
  add_agents_to_room: {
    name: "add_agents_to_room",
    displayName: "Add Agents To Room",
    description:
      "Add one or more agent members to an attached room that you own. If the attached room info says your currentAgentMembershipRole is owner, call this tool directly instead of refusing. Human visibility is unchanged; this only changes the room membership list.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        roomId: { type: "string", description: "The attached room id that should receive new agent members." },
        agentIds: {
          type: "array",
          items: { type: "string", enum: ["concierge", "researcher", "operator"] },
          description: "The agent ids to add to the target room.",
        },
      },
      required: ["roomId", "agentIds"],
    },
    validate: (value: unknown) => addAgentsToRoomArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof addAgentsToRoomArgsSchema>;
      const roomContext = getRoomToolContext(context);
      const room = getAttachedRoom(roomContext, args.roomId);
      assertWritableRoom(room);
      assertRoomOwner(roomContext, room);
      const existingAgentIds = new Set(room.participants.flatMap((participant) => (participant.agentId ? [participant.agentId] : [])));
      const additions = uniqueAgentIds(args.agentIds).filter((agentId) => !existingAgentIds.has(agentId));
      if (additions.length === 0) {
        return createStructuredOutput({
          roomId: room.id,
          title: room.title,
          addedAgentIds: [],
          addedLabels: [],
          participantCount: room.participants.length,
        });
      }

      const action = {
        type: "add_agents_to_room",
        roomId: room.id,
        agentIds: additions,
      } satisfies Extract<Parameters<typeof mutateAddAgentsContext>[1], { type: "add_agents_to_room" }>;
      const nextRoom = mutateAddAgentsContext(roomContext, action);

      return createStructuredOutput(
        {
          roomId: nextRoom.id,
          title: nextRoom.title,
          addedAgentIds: additions,
          addedLabels: additions.map((agentId) => getKnownAgent(roomContext, agentId).label),
          participantCount: nextRoom.participants.length,
        },
        action,
      );
    },
  } satisfies ToolDefinition<unknown>,
  leave_room: {
    name: "leave_room",
    displayName: "Leave Room",
    description:
      "Remove the current agent from one of its attached rooms. If you leave as the owner and other members remain, ownership is reassigned to the earliest remaining member. If nobody remains, the room keeps existing with no owner until someone joins again.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { roomId: { type: "string", description: "The attached room id that the current agent wants to leave." } },
      required: ["roomId"],
    },
    validate: (value: unknown) => leaveRoomArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof leaveRoomArgsSchema>;
      const roomContext = getRoomToolContext(context);
      const room = getAttachedRoom(roomContext, args.roomId);
      assertWritableRoom(room);
      if (!roomContext.currentAgentId) {
        throw new Error("The current agent id is missing, so leave_room cannot be used.");
      }
      if (!room.participants.some((participant) => participant.participantId === roomContext.currentAgentId)) {
        throw new Error(`The current agent is not a member of room ${room.id}.`);
      }

      const action = { type: "leave_room", roomId: room.id } satisfies Extract<Parameters<typeof mutateLeaveRoomContext>[1], { type: "leave_room" }>;
      mutateLeaveRoomContext(roomContext, action);
      return createStructuredOutput(
        {
          roomId: room.id,
          title: room.title,
          leftParticipantId: roomContext.currentAgentId,
        },
        action,
      );
    },
  } satisfies ToolDefinition<unknown>,
  remove_room_participant: {
    name: "remove_room_participant",
    displayName: "Remove Room Participant",
    description:
      "Remove a participant from an attached room that you own. If the attached room info says your currentAgentMembershipRole is owner, use this tool directly. This is the owner-only kick tool and it can target agent or human participant ids that are currently in the room.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        roomId: { type: "string", description: "The attached room id whose participant list should be modified." },
        participantId: { type: "string", description: "The participant id to remove from the room." },
      },
      required: ["roomId", "participantId"],
    },
    validate: (value: unknown) => removeRoomParticipantArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof removeRoomParticipantArgsSchema>;
      const roomContext = getRoomToolContext(context);
      const room = getAttachedRoom(roomContext, args.roomId);
      assertWritableRoom(room);
      assertRoomOwner(roomContext, room);
      if (roomContext.currentAgentId && args.participantId === roomContext.currentAgentId) {
        throw new Error("Use leave_room if you want to remove yourself from a room.");
      }

      const target = room.participants.find((participant) => participant.participantId === args.participantId);
      if (!target) {
        throw new Error(`Participant ${args.participantId} was not found in room ${room.id}.`);
      }

      const action = {
        type: "remove_room_participant",
        roomId: room.id,
        participantId: args.participantId,
      } satisfies Extract<Parameters<typeof mutateRemoveParticipantContext>[1], { type: "remove_room_participant" }>;
      const nextRoom = mutateRemoveParticipantContext(roomContext, action);

      return createStructuredOutput(
        {
          roomId: nextRoom.id,
          title: nextRoom.title,
          removedParticipantId: target.participantId,
          removedParticipantName: target.name,
          participantCount: nextRoom.participants.length,
          ownerParticipantId: nextRoom.ownerParticipantId,
          ownerName: getRoomOwnerName(nextRoom),
        },
        action,
      );
    },
  } satisfies ToolDefinition<unknown>,
  get_room_history: {
    name: "get_room_history",
    displayName: "Get Room History",
    description:
      "Read the visible transcript history of an attached room. You can request how many recent messages to return; the default is 10. This returns only the visible room transcript, not any hidden agent console output.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        roomId: { type: "string", description: "The attached room id whose visible transcript should be returned." },
        limit: { type: "number", description: "How many recent visible room messages to return. Defaults to 10 and is capped at 100." },
      },
      required: ["roomId"],
    },
    validate: (value: unknown) => getRoomHistoryArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof getRoomHistoryArgsSchema>;
      const roomContext = getRoomToolContext(context);
      const room = getAttachedRoom(roomContext, args.roomId);
      const roomHistory = roomContext.roomHistoryById[args.roomId] ?? [];
      const messages = roomHistory.slice(-args.limit);

      return createStructuredOutput({
        room: {
          roomId: room.id,
          title: room.title,
          archived: room.archived,
          ownerParticipantId: room.ownerParticipantId,
          ownerName: getRoomOwnerName(room),
          currentAgentMembershipRole: room.currentAgentMembershipRole,
          currentAgentIsOwner: room.currentAgentIsOwner,
          participantCount: room.participants.length,
          totalVisibleMessages: roomHistory.length,
        },
        returnedCount: messages.length,
        messages,
      });
    },
  } satisfies ToolDefinition<unknown>,
};
