import assert from "node:assert/strict";
import test from "node:test";
import { ROOM_AGENTS } from "@/lib/chat/catalog";
import { createDefaultWorkspaceState, createRoomMessage } from "@/lib/chat/workspace-domain";
import type { ChannelBinding, ExternalInboundMessage, ExternalOutboundMessage } from "@/lib/server/channels/types";
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

test("receiveExternalMessage creates a bound room and delivers emitted replies", async () => {
  await resetChannelDeliveryStateForTest();

  let state = createDefaultWorkspaceState();
  let binding: ChannelBinding | null = null;
  let capturedBinding: ChannelBinding | undefined;
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
      text: "Hello from Feishu",
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
    text: "Same message",
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
