import assert from "node:assert/strict";
import test from "node:test";
import { canApplyConflictWorkspaceSnapshot } from "@/components/workspace/workspace-state";
import { createDefaultWorkspaceState, createRoomMessage, createRoomSession, upsertMessageToRoom } from "@/lib/chat/workspace-domain";

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
