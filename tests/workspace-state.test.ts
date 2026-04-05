import assert from "node:assert/strict";
import test from "node:test";
import { canApplyConflictWorkspaceSnapshot } from "@/components/workspace/workspace-state";
import type { AgentRoomTurn, ProviderCompatibility } from "@/lib/chat/types";
import { createDefaultWorkspaceState, createRoomMessage, createRoomSession, upsertMessageToRoom } from "@/lib/chat/workspace-domain";
import { applyCronTurnToWorkspace, applyRoomTurnToWorkspace } from "@/lib/server/workspace-state";

const TEST_COMPATIBILITY: ProviderCompatibility = {
  providerKey: "generic",
  providerLabel: "Generic",
  baseUrl: "",
  chatCompletionsToolStyle: "tools",
  responsesContinuation: "replay",
  responsesPayloadMode: "json",
  notes: [],
};

test("canApplyConflictWorkspaceSnapshot rejects conflict snapshots that drop a local room", () => {
  const localState = createDefaultWorkspaceState();
  const extraRoom = createRoomSession(2);
  localState.rooms = [localState.rooms[0]!, extraRoom];
  localState.activeRoomId = extraRoom.id;

  const conflictState = createDefaultWorkspaceState();

  assert.equal(
    canApplyConflictWorkspaceSnapshot({
      localState,
      conflictState,
    }),
    false,
  );
});

test("canApplyConflictWorkspaceSnapshot rejects conflict snapshots that miss local room messages", () => {
  const localState = createDefaultWorkspaceState();
  const room = localState.rooms[0]!;
  const localMessage = createRoomMessage(room.id, "assistant", "Local newer reply", "agent_emit");
  localState.rooms = [upsertMessageToRoom(room, localMessage)];

  const conflictState = createDefaultWorkspaceState();
  conflictState.rooms = [room];
  conflictState.activeRoomId = localState.activeRoomId;

  assert.equal(
    canApplyConflictWorkspaceSnapshot({
      localState,
      conflictState,
    }),
    false,
  );
});

test("canApplyConflictWorkspaceSnapshot accepts conflict snapshots that contain all local rooms and messages", () => {
  const localState = createDefaultWorkspaceState();
  const room = localState.rooms[0]!;
  const localMessage = createRoomMessage(room.id, "assistant", "Local reply", "agent_emit");
  const localRoom = upsertMessageToRoom(room, localMessage);
  localState.rooms = [localRoom];

  const conflictState = createDefaultWorkspaceState();
  const conflictExtraMessage = createRoomMessage(room.id, "assistant", "Conflict newer reply", "agent_emit");
  conflictState.rooms = [upsertMessageToRoom(localRoom, conflictExtraMessage)];
  conflictState.activeRoomId = localState.activeRoomId;

  assert.equal(
    canApplyConflictWorkspaceSnapshot({
      localState,
      conflictState,
    }),
    true,
  );
});

test("applyRoomTurnToWorkspace upserts repeated turn ids instead of duplicating them", () => {
  const workspace = createDefaultWorkspaceState();
  const room = workspace.rooms[0]!;
  const userMessage = createRoomMessage(room.id, "system", "Scheduler packet", "system", {
    sender: {
      id: "room-scheduler",
      name: "Room Scheduler",
      role: "system",
    },
    kind: "system",
  });
  const workspaceWithMessage = {
    ...workspace,
    rooms: [upsertMessageToRoom(room, userMessage)],
  };

  const turn: AgentRoomTurn = {
    id: "stream:duplicate-turn",
    agent: {
      id: "concierge",
      label: "Harbor Concierge",
    },
    userMessage,
    assistantContent: "First pass",
    tools: [],
    emittedMessages: [],
    status: "completed",
    resolvedModel: "generic/test-model",
  };
  const once = applyRoomTurnToWorkspace({
    workspace: workspaceWithMessage,
    agentId: "concierge",
    targetRoomId: room.id,
    turn,
    resolvedModel: "generic/test-model",
    compatibility: TEST_COMPATIBILITY,
    emittedMessages: [],
    receiptUpdates: [],
    roomActions: [],
  });
  const twice = applyRoomTurnToWorkspace({
    workspace: once,
    agentId: "concierge",
    targetRoomId: room.id,
    turn: {
      ...turn,
      assistantContent: "Updated pass",
    },
    resolvedModel: "generic/test-model",
    compatibility: TEST_COMPATIBILITY,
    emittedMessages: [],
    receiptUpdates: [],
    roomActions: [],
  });

  assert.equal(twice.rooms[0]?.agentTurns.length, 1);
  assert.equal(twice.agentStates.concierge?.agentTurns.length, 1);
  assert.equal(twice.rooms[0]?.agentTurns[0]?.assistantContent, "Updated pass");
});

test("applyCronTurnToWorkspace keeps the original target-room message while applying receipts and cross-room emissions", () => {
  const workspace = createDefaultWorkspaceState();
  const primaryRoom = workspace.rooms[0]!;
  const secondaryRoom = createRoomSession(2);
  const originalMessage = createRoomMessage(primaryRoom.id, "system", "Original scheduler packet", "system", {
    sender: {
      id: "room-scheduler",
      name: "Room Scheduler",
      role: "system",
    },
    kind: "system",
  });
  const primaryRoomWithMessage = upsertMessageToRoom(primaryRoom, originalMessage);
  const workspaceWithRooms = {
    ...workspace,
    rooms: [primaryRoomWithMessage, secondaryRoom],
  };

  const turn: AgentRoomTurn = {
    id: "cron-turn-1",
    agent: {
      id: "concierge",
      label: "Harbor Concierge",
    },
    userMessage: {
      ...originalMessage,
      content: "Replacement text that cron turns should not write into the room transcript",
    },
    assistantContent: "Cron summary complete.",
    tools: [],
    emittedMessages: [],
    status: "completed",
    resolvedModel: "generic/test-model",
  };

  const receiptCreatedAt = "2026-04-04T10:00:00.000Z";
  const applied = applyCronTurnToWorkspace({
    workspace: workspaceWithRooms,
    agentId: "concierge",
    targetRoomId: primaryRoom.id,
    turn,
    resolvedModel: "generic/test-model",
    compatibility: TEST_COMPATIBILITY,
    emittedMessages: [
      createRoomMessage(secondaryRoom.id, "assistant", "Cross-room follow-up", "agent_emit", {
        sender: {
          id: "concierge",
          name: "Harbor Concierge",
          role: "participant",
        },
      }),
    ],
    receiptUpdates: [
      {
        roomId: primaryRoom.id,
        messageId: originalMessage.id,
        receipt: {
          participantId: "concierge",
          participantName: "Harbor Concierge",
          agentId: "concierge",
          type: "read_no_reply",
          createdAt: receiptCreatedAt,
        },
        receiptStatus: "read_no_reply",
        receiptUpdatedAt: receiptCreatedAt,
      },
    ],
    roomActions: [],
  });

  const updatedPrimaryRoom = applied.rooms.find((room) => room.id === primaryRoom.id);
  const updatedSecondaryRoom = applied.rooms.find((room) => room.id === secondaryRoom.id);
  const updatedOriginalMessage = updatedPrimaryRoom?.roomMessages.find((message) => message.id === originalMessage.id);

  assert.ok(updatedPrimaryRoom);
  assert.ok(updatedSecondaryRoom);
  assert.ok(updatedOriginalMessage);
  assert.equal(updatedOriginalMessage?.content, "Original scheduler packet");
  assert.equal(updatedOriginalMessage?.receiptStatus, "read_no_reply");
  assert.equal(updatedOriginalMessage?.receipts.length, 1);
  assert.equal(updatedPrimaryRoom?.receiptRevision, 1);
  assert.equal(updatedPrimaryRoom?.agentTurns.length, 1);
  assert.equal(updatedSecondaryRoom?.roomMessages.some((message) => message.content === "Cross-room follow-up"), true);
  assert.equal(applied.agentStates.concierge?.agentTurns.length, 1);
  assert.equal(applied.agentStates.concierge?.resolvedModel, "generic/test-model");
});
