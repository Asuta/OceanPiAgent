import type { RoomAgentDefinition, RoomMessage, RoomWorkspaceState } from "@/lib/chat/types";
import { createAgentSharedState, createExternalRoomSession, createRoomMessage, createTimestamp, sortRoomsByUpdatedAt } from "@/lib/chat/workspace-domain";
import { findChannelBinding, touchChannelBinding, upsertChannelBinding } from "@/lib/server/channel-bindings-store";
import { beginInboundMessage, finishInboundMessage, runSerializedDelivery } from "@/lib/server/channel-delivery-queue";
import { createChannelMessageLink, findChannelMessageLink, upsertChannelMessageLink } from "@/lib/server/channel-message-links-store";
import { applyFeishuAckReaction, applyFeishuDoneReaction } from "@/lib/server/channels/feishu/reaction-policy";
import { applyFeishuRoomMetadata, buildFeishuRoomTitle } from "@/lib/server/channels/feishu/room-metadata";
import type { ChannelBinding, ChannelMessageLink, ExternalInboundMessage, ExternalOutboundMessage } from "@/lib/server/channels/types";
import { listAgentDefinitions } from "@/lib/server/agent-registry";
import { appendFeishuRuntimeLog } from "@/lib/server/channel-runtime-log";
import { runRoomTurnNonStreaming } from "@/lib/server/room-runner";
import { applyRoomTurnToWorkspace } from "@/lib/server/workspace-state";
import { loadWorkspaceEnvelope, mutateWorkspace, type WorkspaceEnvelope } from "@/lib/server/workspace-store";
import { createUuid } from "@/lib/utils/uuid";

const EXTERNAL_ERROR_REPLY = "I hit an error while handling that message. Please try again in a moment.";

export interface ExternalMessageServiceDependencies {
  loadWorkspaceEnvelope?: typeof loadWorkspaceEnvelope;
  mutateWorkspace?: typeof mutateWorkspace;
  findChannelBinding?: typeof findChannelBinding;
  upsertChannelBinding?: typeof upsertChannelBinding;
  touchChannelBinding?: typeof touchChannelBinding;
  findChannelMessageLink?: typeof findChannelMessageLink;
  upsertChannelMessageLink?: typeof upsertChannelMessageLink;
  applyFeishuAckReaction?: typeof applyFeishuAckReaction;
  applyFeishuDoneReaction?: typeof applyFeishuDoneReaction;
  listAgentDefinitions?: () => Promise<RoomAgentDefinition[]>;
  runRoomTurnNonStreaming?: typeof runRoomTurnNonStreaming;
  deliverMessages?: (messages: ExternalOutboundMessage[]) => Promise<void>;
  logger?: (args: {
    level: "info" | "warn" | "error";
    message: string;
    details?: Record<string, string | number | boolean | null | undefined>;
  }) => void;
}

export interface ExternalMessageProcessResult {
  status: "processed" | "duplicate";
  roomId?: string;
  emittedCount?: number;
}

interface PreparedExternalMessageProcessing {
  binding: ChannelBinding;
  inboundRoomMessage: RoomMessage;
  workspace: RoomWorkspaceState;
  messageLink: ChannelMessageLink;
}

function buildQueueKey(message: ExternalInboundMessage): string {
  return `${message.channel}:${message.accountId}:${message.peerKind}:${message.peerId}`;
}

function buildMessageDedupKey(message: ExternalInboundMessage): string {
  return `${message.channel}:${message.accountId}:${message.messageId}`;
}

function buildHumanParticipantId(message: ExternalInboundMessage): string {
  return `${message.channel}:${message.accountId}:${message.peerKind}:${message.peerId}`;
}

function buildInboundRoomMessageId(message: ExternalInboundMessage): string {
  return `${message.channel}:${message.accountId}:${message.messageId}`;
}

function buildExternalRoomTitle(message: ExternalInboundMessage): string {
  return buildFeishuRoomTitle(message.senderName || message.senderId || message.peerId, message.peerId);
}

function hasReadNoReplyForInboundMessage(result: Awaited<ReturnType<typeof runRoomTurnNonStreaming>>, roomId: string, roomMessageId: string): boolean {
  return result.roomActions.some((action) => action.type === "read_no_reply" && action.roomId === roomId && action.messageId === roomMessageId);
}

function hasNewerUserMessageInRoom(workspace: RoomWorkspaceState, roomId: string, roomMessageId: string): boolean {
  const room = workspace.rooms.find((entry) => entry.id === roomId);
  if (!room) {
    return false;
  }

  const currentMessage = room.roomMessages.find((entry) => entry.id === roomMessageId);
  if (!currentMessage) {
    return false;
  }

  return room.roomMessages.some((entry) => entry.seq > currentMessage.seq && entry.role === "user");
}

async function ensureChannelMessageLink(args: {
  message: ExternalInboundMessage;
  binding: ChannelBinding;
  roomMessageId: string;
  deps: Required<ExternalMessageServiceDependencies>;
}): Promise<ChannelMessageLink> {
  const existing = await args.deps.findChannelMessageLink({
    channel: args.message.channel,
    accountId: args.message.accountId,
    externalMessageId: args.message.messageId,
  });
  if (existing) {
    return existing;
  }

  return args.deps.upsertChannelMessageLink(createChannelMessageLink({
    linkId: createUuid(),
    channel: args.message.channel,
    accountId: args.message.accountId,
    peerKind: args.message.peerKind,
    peerId: args.message.peerId,
    externalMessageId: args.message.messageId,
    roomId: args.binding.roomId,
    roomMessageId: args.roomMessageId,
    messageType: args.message.messageType,
    createdAt: createTimestamp(),
  }));
}

async function prepareExternalMessageProcessing(
  message: ExternalInboundMessage,
  deps: Required<ExternalMessageServiceDependencies>,
): Promise<PreparedExternalMessageProcessing | null> {
  return runSerializedDelivery(buildQueueKey(message), async () => {
    const dedupeKey = buildMessageDedupKey(message);
    const dedupeState = await beginInboundMessage(dedupeKey);
    if (dedupeState !== "started") {
      deps.logger({
        level: "info",
        message: "Skipped duplicate inbound Feishu message",
        details: {
          peerId: message.peerId,
          messageId: message.messageId,
          messageType: message.messageType,
          dedupeState,
        },
      });
      return null;
    }

    let accepted = false;
    try {
      const { binding } = await ensureBindingAndWorkspace(message, deps);
      const inboundRoomMessage = createInboundRoomMessage(message, binding);
      const workspaceWithMessage = await appendInboundMessageToWorkspace(inboundRoomMessage, binding, message.senderName, deps);
      let messageLink = await ensureChannelMessageLink({
        message,
        binding,
        roomMessageId: inboundRoomMessage.id,
        deps,
      });
      messageLink = await deps.applyFeishuAckReaction(messageLink, { logger: deps.logger });
      accepted = true;
      return {
        binding,
        inboundRoomMessage,
        workspace: workspaceWithMessage.state,
        messageLink,
      };
    } finally {
      await finishInboundMessage(dedupeKey, accepted);
    }
  });
}

function createInboundRoomMessage(message: ExternalInboundMessage, binding: ChannelBinding): RoomMessage {
  return {
    ...createRoomMessage(binding.roomId, "user", message.text, "user", {
      sender: {
        id: binding.humanParticipantId,
        name: message.senderName,
        role: "participant",
      },
      attachments: message.attachments,
    }),
    id: buildInboundRoomMessageId(message),
  };
}

async function createBoundRoom(message: ExternalInboundMessage, deps: Required<ExternalMessageServiceDependencies>): Promise<{ binding: ChannelBinding; workspace: RoomWorkspaceState }> {
  const agentDefinitions = await deps.listAgentDefinitions();
  const roomId = createUuid();
  const humanParticipantId = buildHumanParticipantId(message);
  const room = createExternalRoomSession({
    roomId,
    title: buildExternalRoomTitle(message),
    agentId: message.agentId || "concierge",
    humanParticipantId,
    humanParticipantName: message.senderName,
    agentDefinitions,
  });

  const workspaceEnvelope = await deps.mutateWorkspace((workspace) => ({
    ...workspace,
    rooms: sortRoomsByUpdatedAt([room, ...workspace.rooms]),
    agentStates: workspace.agentStates[room.agentId]
      ? workspace.agentStates
      : {
          ...workspace.agentStates,
          [room.agentId]: createAgentSharedState(),
        },
  }));

  const timestamp = createTimestamp();
  const binding: ChannelBinding = {
    bindingId: createUuid(),
    channel: message.channel,
    accountId: message.accountId,
    peerKind: message.peerKind,
    peerId: message.peerId,
    roomId,
    humanParticipantId,
    agentId: room.agentId,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastInboundAt: null,
  };
  await deps.upsertChannelBinding(binding);
  deps.logger({
    level: "info",
    message: "Created Feishu room binding",
    details: {
      peerId: message.peerId,
      roomId,
      agentId: room.agentId,
    },
  });
  return {
    binding,
    workspace: workspaceEnvelope.state,
  };
}

async function ensureBindingAndWorkspace(message: ExternalInboundMessage, deps: Required<ExternalMessageServiceDependencies>): Promise<{ binding: ChannelBinding; workspace: RoomWorkspaceState }> {
  const existingBinding = await deps.findChannelBinding({
    channel: message.channel,
    accountId: message.accountId,
    peerKind: message.peerKind,
    peerId: message.peerId,
  });

  if (!existingBinding) {
    return createBoundRoom(message, deps);
  }

  const workspaceEnvelope = await deps.loadWorkspaceEnvelope();
  const existingRoom = workspaceEnvelope.state.rooms.find((room) => room.id === existingBinding.roomId);
  if (existingRoom) {
    return {
      binding: existingBinding,
      workspace: workspaceEnvelope.state,
    };
  }

  const recreated = await createBoundRoom(message, deps);
  const nextBinding: ChannelBinding = {
    ...recreated.binding,
    bindingId: existingBinding.bindingId,
    humanParticipantId: existingBinding.humanParticipantId,
    createdAt: existingBinding.createdAt,
  };
  await deps.upsertChannelBinding(nextBinding);
  return {
    binding: nextBinding,
    workspace: recreated.workspace,
  };
}

async function appendInboundMessageToWorkspace(
  message: RoomMessage,
  binding: ChannelBinding,
  senderName: string,
  deps: Required<ExternalMessageServiceDependencies>,
): Promise<WorkspaceEnvelope> {
  return deps.mutateWorkspace((workspace) => ({
    ...workspace,
    rooms: workspace.rooms.map((room) => {
      if (room.id !== binding.roomId) {
        return room;
      }

      const nextRoom = applyFeishuRoomMetadata(room, binding, senderName);
      return {
        ...nextRoom,
        roomMessages: [...nextRoom.roomMessages, {
          ...message,
          seq: (nextRoom.roomMessages[nextRoom.roomMessages.length - 1]?.seq ?? 0) + 1,
        }],
        error: "",
      };
    }),
  }));
}

function createExternalOutboundMessages(binding: ChannelBinding, emittedMessages: RoomMessage[]): ExternalOutboundMessage[] {
  return emittedMessages
    .filter((message) => message.roomId === binding.roomId && message.content.trim())
    .map((message) => ({
      channel: binding.channel,
      accountId: binding.accountId,
      peerKind: binding.peerKind,
      peerId: binding.peerId,
      roomId: binding.roomId,
      content: message.content,
    }));
}

export async function receiveExternalMessage(message: ExternalInboundMessage, overrides: ExternalMessageServiceDependencies = {}): Promise<ExternalMessageProcessResult> {
  const deps: Required<ExternalMessageServiceDependencies> = {
    loadWorkspaceEnvelope: overrides.loadWorkspaceEnvelope ?? loadWorkspaceEnvelope,
    mutateWorkspace: overrides.mutateWorkspace ?? mutateWorkspace,
    findChannelBinding: overrides.findChannelBinding ?? findChannelBinding,
    upsertChannelBinding: overrides.upsertChannelBinding ?? upsertChannelBinding,
    touchChannelBinding: overrides.touchChannelBinding ?? touchChannelBinding,
    findChannelMessageLink: overrides.findChannelMessageLink ?? findChannelMessageLink,
    upsertChannelMessageLink: overrides.upsertChannelMessageLink ?? upsertChannelMessageLink,
    applyFeishuAckReaction: overrides.applyFeishuAckReaction ?? applyFeishuAckReaction,
    applyFeishuDoneReaction: overrides.applyFeishuDoneReaction ?? applyFeishuDoneReaction,
    listAgentDefinitions: overrides.listAgentDefinitions ?? listAgentDefinitions,
    runRoomTurnNonStreaming: overrides.runRoomTurnNonStreaming ?? runRoomTurnNonStreaming,
    deliverMessages: overrides.deliverMessages ?? (async () => {}),
    logger: overrides.logger ?? appendFeishuRuntimeLog,
  };

  const prepared = await prepareExternalMessageProcessing(message, deps);
  if (!prepared) {
    return { status: "duplicate" };
  }
  const processing = prepared;

  try {
    const settings = processing.workspace.agentStates[processing.binding.agentId]?.settings ?? createAgentSharedState().settings;
    const result = await deps.runRoomTurnNonStreaming({
      workspace: processing.workspace,
      roomId: processing.binding.roomId,
      agentId: processing.binding.agentId,
      message: {
        id: processing.inboundRoomMessage.id,
        content: processing.inboundRoomMessage.content,
        attachments: processing.inboundRoomMessage.attachments,
        sender: processing.inboundRoomMessage.sender,
      },
      settings,
    });

    let wasSuperseded = false;
    await deps.mutateWorkspace((workspace) => {
      if (hasNewerUserMessageInRoom(workspace, processing.binding.roomId, processing.inboundRoomMessage.id)) {
        wasSuperseded = true;
        return workspace;
      }

      return applyRoomTurnToWorkspace({
        workspace,
        agentId: processing.binding.agentId,
        targetRoomId: processing.binding.roomId,
        turn: result.turn,
        resolvedModel: result.resolvedModel,
        compatibility: result.compatibility,
        emittedMessages: result.emittedMessages,
        receiptUpdates: result.receiptUpdates,
        roomActions: result.roomActions,
      });
    });

    await deps.touchChannelBinding({
      channel: processing.binding.channel,
      accountId: processing.binding.accountId,
      peerKind: processing.binding.peerKind,
      peerId: processing.binding.peerId,
    });

    if (wasSuperseded) {
      deps.logger({
        level: "info",
        message: "Skipped superseded Feishu turn result",
        details: {
          peerId: processing.binding.peerId,
          roomId: processing.binding.roomId,
          messageId: message.messageId,
          messageType: message.messageType,
        },
      });
      return {
        status: "processed",
        roomId: processing.binding.roomId,
        emittedCount: 0,
      };
    }

    const outboundMessages = createExternalOutboundMessages(processing.binding, result.emittedMessages);
    if (outboundMessages.length === 0 && result.turn.status === "error") {
      outboundMessages.push({
        channel: processing.binding.channel,
        accountId: processing.binding.accountId,
        peerKind: processing.binding.peerKind,
        peerId: processing.binding.peerId,
        roomId: processing.binding.roomId,
        content: EXTERNAL_ERROR_REPLY,
      });
    }
    await deps.deliverMessages(outboundMessages);

    if (hasReadNoReplyForInboundMessage(result, processing.binding.roomId, processing.inboundRoomMessage.id)) {
      await deps.applyFeishuDoneReaction(processing.messageLink, { logger: deps.logger });
    }

    deps.logger({
        level: result.turn.status === "error" ? "warn" : "info",
        message: "Processed inbound Feishu message",
        details: {
        peerId: processing.binding.peerId,
        roomId: processing.binding.roomId,
        messageId: message.messageId,
        messageType: message.messageType,
        attachmentCount: message.attachments.length,
        emittedCount: outboundMessages.length,
        turnStatus: result.turn.status,
      },
    });

    return {
      status: "processed",
      roomId: processing.binding.roomId,
      emittedCount: outboundMessages.length,
    };
  } catch (error) {
    deps.logger({
      level: "error",
      message: "Failed to process inbound Feishu message",
      details: {
        peerId: message.peerId,
        messageId: message.messageId,
        messageType: message.messageType,
        error: error instanceof Error ? error.message : "Unknown channel processing error.",
      },
    });
    throw error;
  }
}
