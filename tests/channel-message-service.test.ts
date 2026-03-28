import assert from "node:assert/strict";
import test from "node:test";
import { ROOM_AGENTS } from "@/lib/chat/catalog";
import { createDefaultWorkspaceState, createRoomMessage } from "@/lib/chat/workspace-domain";
import type { MessageImageAttachment } from "@/lib/chat/types";
import type { ChannelBinding, ChannelMessageLink, ExternalInboundMessage, ExternalOutboundMessage } from "@/lib/server/channels/types";
import { resetChannelDeliveryStateForTest } from "@/lib/server/channel-delivery-queue";
import { receiveExternalMessage } from "@/lib/server/channel-message-service";

const COMPATIBILITY = {
  providerKey: "generic" as const,
  providerLabel: "Generic",
  baseUrl: "https://example.test/v1",
  chatCompletionsToolStyle: "tools" as const,
  responsesContinuation: "replay" as const,
  responsesPayloadMode: "json" as const,
  notes: [],
};

const SAMPLE_ATTACHMENT: MessageImageAttachment = {
  id: "image-1",
  kind: "image",
  mimeType: "image/jpeg",
  filename: "feishu.jpg",
  sizeBytes: 1024,
  storagePath: "images/feishu.jpg",
  url: "/api/uploads/image/images/feishu.jpg",
};

test("receiveExternalMessage creates a bound room and delivers emitted replies", async () => {
  await resetChannelDeliveryStateForTest();

  let state = createDefaultWorkspaceState();
  let binding: ChannelBinding | null = null;
  let capturedBinding: ChannelBinding | undefined;
  let ackReactionApplied = false;
  let doneReactionApplied = false;
  let messageLink = null as null | { externalMessageId: string; roomMessageId: string };
  const outboundMessages: ExternalOutboundMessage[] = [];

  const result = await receiveExternalMessage(
    {
      channel: "feishu",
      accountId: "default",
      peerKind: "direct",
      peerId: "ou_123",
      senderId: "ou_123",
      senderName: "Alice",
      messageId: "msg-1",
      messageType: "text",
      text: "Hello from Feishu",
      attachments: [],
      agentId: "concierge",
    },
    {
      loadWorkspaceEnvelope: async () => ({ version: 1, updatedAt: new Date().toISOString(), state }),
      mutateWorkspace: async (mutator) => {
        state = await mutator(state);
        return { version: 1, updatedAt: new Date().toISOString(), state };
      },
      findChannelBinding: async () => binding,
      upsertChannelBinding: async (nextBinding) => {
        binding = nextBinding;
        capturedBinding = nextBinding;
        return nextBinding;
      },
      touchChannelBinding: async () => {
        if (!binding) {
          return null;
        }
        binding = {
          ...binding,
          updatedAt: "2026-03-27T10:01:00.000Z",
          lastInboundAt: "2026-03-27T10:01:00.000Z",
        };
        capturedBinding = binding;
        return binding;
      },
      findChannelMessageLink: async () => null,
      upsertChannelMessageLink: async (nextLink: ChannelMessageLink) => {
        messageLink = {
          externalMessageId: nextLink.externalMessageId,
          roomMessageId: nextLink.roomMessageId,
        };
        return nextLink;
      },
      applyFeishuAckReaction: async (link) => {
        ackReactionApplied = true;
        return {
          ...link,
          ackReaction: {
            emojiType: "OK",
            appliedAt: "2026-03-27T10:00:30.000Z",
          },
        };
      },
      applyFeishuDoneReaction: async (link) => {
        doneReactionApplied = true;
        return {
          ...link,
          doneReaction: {
            emojiType: "DONE",
            appliedAt: "2026-03-27T10:00:31.000Z",
          },
        };
      },
      listAgentDefinitions: async () => ROOM_AGENTS,
      runRoomTurnNonStreaming: async ({ roomId, message, agentId }) => ({
        turn: {
          id: "turn-1",
          agent: {
            id: agentId,
            label: "Harbor Concierge",
          },
          userMessage: {
            ...createRoomMessage(roomId, "user", message.content, "user", { sender: message.sender }),
            id: message.id,
          },
          assistantContent: "Processed internally.",
          tools: [],
          emittedMessages: [
            createRoomMessage(roomId, "assistant", "Visible Feishu reply", "agent_emit", {
              sender: {
                id: agentId,
                name: "Harbor Concierge",
                role: "participant",
              },
            }),
          ],
          status: "completed",
          resolvedModel: "generic/fake-model",
        },
        resolvedModel: "generic/fake-model",
        compatibility: COMPATIBILITY,
        emittedMessages: [
          createRoomMessage(roomId, "assistant", "Visible Feishu reply", "agent_emit", {
            sender: {
              id: agentId,
              name: "Harbor Concierge",
              role: "participant",
            },
          }),
        ],
        receiptUpdates: [],
        roomActions: [],
      }),
      deliverMessages: async (messages) => {
        outboundMessages.push(...messages);
      },
    },
  );

  assert.equal(result.status, "processed");
  const createdBinding = capturedBinding;
  assert.ok(createdBinding);
  assert.equal(createdBinding.peerId, "ou_123");
  assert.equal(outboundMessages.length, 1);
  assert.equal(outboundMessages[0]?.content, "Visible Feishu reply");
  assert.equal(ackReactionApplied, true);
  assert.equal(doneReactionApplied, false);
  assert.equal(messageLink?.externalMessageId, "msg-1");

  const feishuRoom = state.rooms.find((room) => room.id === createdBinding.roomId);
  assert.ok(feishuRoom);
  assert.equal(feishuRoom?.title, "Feishu - Alice");
  assert.equal(feishuRoom?.participants.find((participant) => participant.id === createdBinding.humanParticipantId)?.name, "Alice");
  assert.equal(feishuRoom?.agentTurns.length, 1);
  assert.ok(feishuRoom?.roomMessages.some((message) => message.content === "Hello from Feishu"));
  assert.ok(feishuRoom?.roomMessages.some((message) => message.content === "Visible Feishu reply"));
  assert.equal(state.agentStates[createdBinding.agentId]?.resolvedModel, "generic/fake-model");
});

test("receiveExternalMessage deduplicates repeated inbound message ids", async () => {
  await resetChannelDeliveryStateForTest();

  const state = createDefaultWorkspaceState();
  let runCount = 0;
  let binding: ChannelBinding = {
    bindingId: "binding-1",
    channel: "feishu",
    accountId: "default",
    peerKind: "direct",
    peerId: "ou_123",
    roomId: state.rooms[0]?.id || "room-1",
    humanParticipantId: "feishu:default:direct:ou_123",
    agentId: state.rooms[0]?.agentId || "concierge",
    createdAt: "2026-03-27T10:00:00.000Z",
    updatedAt: "2026-03-27T10:00:00.000Z",
    lastInboundAt: null,
  };

  const message: ExternalInboundMessage = {
    channel: "feishu",
    accountId: "default",
    peerKind: "direct",
    peerId: "ou_123",
      senderId: "ou_123",
      senderName: "ou_123",
      messageId: "msg-dup",
      messageType: "text",
      text: "Same message",
      attachments: [],
      agentId: "concierge",
    };

  const deps = {
    loadWorkspaceEnvelope: async () => ({ version: 1, updatedAt: new Date().toISOString(), state }),
    mutateWorkspace: async () => ({ version: 1, updatedAt: new Date().toISOString(), state }),
    findChannelBinding: async () => binding,
    upsertChannelBinding: async (nextBinding: ChannelBinding) => {
      binding = nextBinding;
      return nextBinding;
    },
    touchChannelBinding: async () => binding,
    findChannelMessageLink: async () => null,
    upsertChannelMessageLink: async (nextLink: ChannelMessageLink) => nextLink,
    applyFeishuAckReaction: async (link: ChannelMessageLink) => link,
    applyFeishuDoneReaction: async (link: ChannelMessageLink) => link,
    listAgentDefinitions: async () => ROOM_AGENTS,
    runRoomTurnNonStreaming: async () => {
      runCount += 1;
      return {
        turn: {
          id: "turn-dup",
          agent: {
            id: "concierge",
            label: "Harbor Concierge",
          },
          userMessage: createRoomMessage(binding.roomId, "user", "Same message", "user"),
          assistantContent: "Done",
          tools: [],
          emittedMessages: [],
          status: "completed" as const,
        },
        resolvedModel: "generic/fake-model",
        compatibility: COMPATIBILITY,
        emittedMessages: [],
        receiptUpdates: [],
        roomActions: [],
      };
    },
    deliverMessages: async () => {},
  };

  const first = await receiveExternalMessage(message, deps);
  const second = await receiveExternalMessage(message, deps);

  assert.equal(first.status, "processed");
  assert.equal(second.status, "duplicate");
  assert.equal(runCount, 1);
});

test("receiveExternalMessage preserves inbound Feishu image attachments", async () => {
  await resetChannelDeliveryStateForTest();

  let state = createDefaultWorkspaceState();
  let binding: ChannelBinding | null = null;
  let ackReactionApplied = false;
  let doneReactionApplied = false;

  await receiveExternalMessage(
    {
      channel: "feishu",
      accountId: "default",
      peerKind: "direct",
      peerId: "ou_456",
      senderId: "ou_456",
      senderName: "Photo User",
      messageId: "msg-image-1",
      messageType: "image",
      text: "",
      attachments: [SAMPLE_ATTACHMENT],
      agentId: "concierge",
    },
    {
      loadWorkspaceEnvelope: async () => ({ version: 1, updatedAt: new Date().toISOString(), state }),
      mutateWorkspace: async (mutator) => {
        state = await mutator(state);
        return { version: 1, updatedAt: new Date().toISOString(), state };
      },
      findChannelBinding: async () => binding,
      upsertChannelBinding: async (nextBinding) => {
        binding = nextBinding;
        return nextBinding;
      },
      touchChannelBinding: async () => binding,
      findChannelMessageLink: async () => null,
      upsertChannelMessageLink: async (nextLink: ChannelMessageLink) => nextLink,
      applyFeishuAckReaction: async (link) => {
        ackReactionApplied = true;
        return link;
      },
      applyFeishuDoneReaction: async (link) => {
        doneReactionApplied = true;
        return link;
      },
      listAgentDefinitions: async () => ROOM_AGENTS,
      runRoomTurnNonStreaming: async ({ roomId, message, agentId }) => ({
        turn: {
          id: "turn-image-1",
          agent: {
            id: agentId,
            label: "Harbor Concierge",
          },
          userMessage: {
            ...createRoomMessage(roomId, "user", message.content, "user", { sender: message.sender, attachments: message.attachments }),
            id: message.id,
          },
          assistantContent: "I can see the image.",
          tools: [],
          emittedMessages: [],
          status: "completed",
          resolvedModel: "generic/fake-model",
        },
        resolvedModel: "generic/fake-model",
        compatibility: COMPATIBILITY,
        emittedMessages: [],
        receiptUpdates: [],
        roomActions: [],
      }),
      deliverMessages: async () => {},
    },
  );

  const room = state.rooms.find((entry) => entry.id === binding?.roomId);
  assert.ok(room);
  const inboundMessage = room?.roomMessages.find((entry) => entry.id === "feishu:default:msg-image-1");
  assert.ok(inboundMessage);
  assert.equal(inboundMessage?.attachments.length, 1);
  assert.equal(inboundMessage?.attachments[0]?.filename, "feishu.jpg");
  assert.equal(ackReactionApplied, true);
  assert.equal(doneReactionApplied, false);
});

test("receiveExternalMessage applies DONE reaction only for read-no-reply", async () => {
  await resetChannelDeliveryStateForTest();

  let state = createDefaultWorkspaceState();
  let binding: ChannelBinding | null = null;
  let ackReactionApplied = false;
  let doneReactionApplied = false;

  await receiveExternalMessage(
    {
      channel: "feishu",
      accountId: "default",
      peerKind: "direct",
      peerId: "ou_done",
      senderId: "ou_done",
      senderName: "Quiet User",
      messageId: "msg-done-1",
      messageType: "text",
      text: "ok",
      attachments: [],
      agentId: "concierge",
    },
    {
      loadWorkspaceEnvelope: async () => ({ version: 1, updatedAt: new Date().toISOString(), state }),
      mutateWorkspace: async (mutator) => {
        state = await mutator(state);
        return { version: 1, updatedAt: new Date().toISOString(), state };
      },
      findChannelBinding: async () => binding,
      upsertChannelBinding: async (nextBinding) => {
        binding = nextBinding;
        return nextBinding;
      },
      touchChannelBinding: async () => binding,
      findChannelMessageLink: async () => null,
      upsertChannelMessageLink: async (nextLink: ChannelMessageLink) => nextLink,
      applyFeishuAckReaction: async (link) => {
        ackReactionApplied = true;
        return link;
      },
      applyFeishuDoneReaction: async (link) => {
        doneReactionApplied = true;
        return link;
      },
      listAgentDefinitions: async () => ROOM_AGENTS,
      runRoomTurnNonStreaming: async ({ roomId, message, agentId }) => ({
        turn: {
          id: "turn-done-1",
          agent: {
            id: agentId,
            label: "Harbor Concierge",
          },
          userMessage: {
            ...createRoomMessage(roomId, "user", message.content, "user", { sender: message.sender }),
            id: message.id,
          },
          assistantContent: "",
          tools: [],
          emittedMessages: [],
          status: "completed",
          resolvedModel: "generic/fake-model",
        },
        resolvedModel: "generic/fake-model",
        compatibility: COMPATIBILITY,
        emittedMessages: [],
        receiptUpdates: [],
        roomActions: [{ type: "read_no_reply", roomId, messageId: message.id }],
      }),
      deliverMessages: async () => {},
    },
  );

  assert.equal(ackReactionApplied, true);
  assert.equal(doneReactionApplied, true);
});
