import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultWorkspaceState, createExternalRoomSession } from "@/lib/chat/workspace-domain";
import { backfillFeishuRoomNicknames } from "@/lib/server/channels/feishu/backfill";
import type { ChannelBinding } from "@/lib/server/channels/types";

test("backfillFeishuRoomNicknames updates existing room title and participant name", async () => {
  const binding: ChannelBinding = {
    bindingId: "binding-1",
    channel: "feishu",
    accountId: "default",
    peerKind: "direct",
    peerId: "ou_123",
    roomId: "room-1",
    humanParticipantId: "feishu:default:direct:ou_123",
    agentId: "concierge",
    createdAt: "2026-03-27T10:00:00.000Z",
    updatedAt: "2026-03-27T10:00:00.000Z",
    lastInboundAt: null,
  };

  let workspace = createDefaultWorkspaceState();
  workspace = {
    ...workspace,
    rooms: [
      createExternalRoomSession({
        roomId: binding.roomId,
        title: "Feishu - ou_123",
        agentId: binding.agentId,
        humanParticipantId: binding.humanParticipantId,
        humanParticipantName: "ou_123",
      }),
      ...workspace.rooms,
    ],
  };

  const result = await backfillFeishuRoomNicknames({
    readConfig: () => ({
      enabled: true,
      configured: true,
      accountId: "default",
      appId: "app-id",
      appSecret: "app-secret",
      defaultAgentId: "concierge",
      allowOpenIds: [],
    }),
    loadBindings: async () => [binding],
    resolveDisplayName: async () => "Alice",
    mutateWorkspace: async (mutator) => {
      workspace = await mutator(workspace);
      return {
        version: 1,
        updatedAt: new Date().toISOString(),
        state: workspace,
      };
    },
    logger: ({ level, message, details }) => ({
      id: `${level}-${message}`,
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(details
        ? {
            details: Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) as Record<string, string | number | boolean | null>,
          }
        : {}),
    }),
  });

  assert.deepEqual(result, {
    scanned: 1,
    updated: 1,
    skipped: 0,
  });
  const room = workspace.rooms.find((entry) => entry.id === binding.roomId);
  assert.equal(room?.title, "Feishu - Alice");
  assert.equal(room?.participants.find((participant) => participant.id === binding.humanParticipantId)?.name, "Alice");
});
