import assert from "node:assert/strict";
import test from "node:test";
import { canApplyConflictWorkspaceSnapshot } from "@/components/workspace/workspace-state";
import type { AgentRoomTurn, ProviderCompatibility } from "@/lib/chat/types";
import { createDefaultWorkspaceState, createRoomMessage, createRoomSession, upsertMessageToRoom } from "@/lib/chat/workspace-domain";
import { applyRoomTurnToWorkspace } from "@/lib/server/workspace-state";

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
  const compatibility: ProviderCompatibility = {
    providerKey: "generic",
    providerLabel: "Generic",
    baseUrl: "",
    chatCompletionsToolStyle: "tools",
    responsesContinuation: "replay",
    responsesPayloadMode: "json",
    notes: [],
  };

  const once = applyRoomTurnToWorkspace({
    workspace: workspaceWithMessage,
    agentId: "concierge",
    targetRoomId: room.id,
    turn,
    resolvedModel: "generic/test-model",
    compatibility,
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
    compatibility,
    emittedMessages: [],
    receiptUpdates: [],
    roomActions: [],
  });

  assert.equal(twice.rooms[0]?.agentTurns.length, 1);
  assert.equal(twice.agentStates.concierge?.agentTurns.length, 1);
  assert.equal(twice.rooms[0]?.agentTurns[0]?.assistantContent, "Updated pass");
});
