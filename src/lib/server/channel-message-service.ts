import type { RoomAgentDefinition, RoomMessage, RoomWorkspaceState } from "@/lib/chat/types";
import { createAgentSharedState, createExternalRoomSession, createRoomMessage, createTimestamp, sortRoomsByUpdatedAt } from "@/lib/chat/workspace-domain";
import { findChannelBinding, touchChannelBinding, upsertChannelBinding } from "@/lib/server/channel-bindings-store";
import { beginInboundMessage, finishInboundMessage, runSerializedDelivery } from "@/lib/server/channel-delivery-queue";
import type { ChannelBinding, ExternalInboundMessage, ExternalOutboundMessage } from "@/lib/server/channels/types";
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
  const label = message.senderName.trim() || message.senderId.trim() || message.peerId.trim();
  return `Feishu - ${label}`;
}

function applyExternalRoomMetadata(room: RoomWorkspaceState["rooms"][number], binding: ChannelBinding, senderName: string) {
  const normalizedName = senderName.trim() || binding.peerId;
  return {
    ...room,
    title: buildExternalRoomTitle({
      channel: binding.channel,
      accountId: binding.accountId,
      peerKind: binding.peerKind,
      peerId: binding.peerId,
      messageId: "",
      text: "",
      senderId: binding.peerId,
      senderName: normalizedName,
    }),
    participants: room.participants.map((participant) => (
      participant.id === binding.humanParticipantId
        ? {
            ...participant,
            name: normalizedName,
            updatedAt: createTimestamp(),
          }
        : participant
    )),
  };
}

function createInboundRoomMessage(message: ExternalInboundMessage, binding: ChannelBinding): RoomMessage {
  return {
    ...createRoomMessage(binding.roomId, "user", message.text, "user", {
      sender: {
        id: binding.humanParticipantId,
        name: message.senderName,
        role: "participant",
      },
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

      const nextRoom = applyExternalRoomMetadata(room, binding, senderName);
      return {
        ...nextRoom,
        roomMessages: [...nextRoom.roomMessages, {
          ...message,
          seq: (nextRoom.roomMessages[nextRoom.roomMessages.length - 1]?.seq ?? 0) + 1,
        }],
        updatedAt: createTimestamp(),
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
    listAgentDefinitions: overrides.listAgentDefinitions ?? listAgentDefinitions,
    runRoomTurnNonStreaming: overrides.runRoomTurnNonStreaming ?? runRoomTurnNonStreaming,
    deliverMessages: overrides.deliverMessages ?? (async () => {}),
    logger: overrides.logger ?? appendFeishuRuntimeLog,
  };

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
          dedupeState,
        },
      });
      return { status: "duplicate" };
    }

    let succeeded = false;
    try {
      const { binding } = await ensureBindingAndWorkspace(message, deps);
      const inboundRoomMessage = createInboundRoomMessage(message, binding);
      const workspaceWithMessage = await appendInboundMessageToWorkspace(inboundRoomMessage, binding, message.senderName, deps);
      const settings = workspaceWithMessage.state.agentStates[binding.agentId]?.settings ?? createAgentSharedState().settings;
      const result = await deps.runRoomTurnNonStreaming({
        workspace: workspaceWithMessage.state,
        roomId: binding.roomId,
        agentId: binding.agentId,
        message: {
          id: inboundRoomMessage.id,
          content: inboundRoomMessage.content,
          attachments: inboundRoomMessage.attachments,
          sender: inboundRoomMessage.sender,
        },
        settings,
      });

      await deps.mutateWorkspace((workspace) => applyRoomTurnToWorkspace({
        workspace,
        agentId: binding.agentId,
        targetRoomId: binding.roomId,
        turn: result.turn,
        resolvedModel: result.resolvedModel,
        compatibility: result.compatibility,
        emittedMessages: result.emittedMessages,
        receiptUpdates: result.receiptUpdates,
        roomActions: result.roomActions,
      }));

      await deps.touchChannelBinding({
        channel: binding.channel,
        accountId: binding.accountId,
        peerKind: binding.peerKind,
        peerId: binding.peerId,
      });

      const outboundMessages = createExternalOutboundMessages(binding, result.emittedMessages);
      if (outboundMessages.length === 0 && result.turn.status === "error") {
        outboundMessages.push({
          channel: binding.channel,
          accountId: binding.accountId,
          peerKind: binding.peerKind,
          peerId: binding.peerId,
          roomId: binding.roomId,
          content: EXTERNAL_ERROR_REPLY,
        });
      }
      await deps.deliverMessages(outboundMessages);

      deps.logger({
        level: result.turn.status === "error" ? "warn" : "info",
        message: "Processed inbound Feishu message",
        details: {
          peerId: binding.peerId,
          roomId: binding.roomId,
          messageId: message.messageId,
          emittedCount: outboundMessages.length,
          turnStatus: result.turn.status,
        },
      });

      succeeded = true;
      return {
        status: "processed",
        roomId: binding.roomId,
        emittedCount: outboundMessages.length,
      };
    } catch (error) {
      deps.logger({
        level: "error",
        message: "Failed to process inbound Feishu message",
        details: {
          peerId: message.peerId,
          messageId: message.messageId,
          error: error instanceof Error ? error.message : "Unknown channel processing error.",
        },
      });
      throw error;
    } finally {
      await finishInboundMessage(dedupeKey, succeeded);
    }
  });
}
