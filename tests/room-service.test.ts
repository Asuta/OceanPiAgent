import assert from "node:assert/strict";
import test from "node:test";
import { addAgentParticipantToRoom } from "@/lib/chat/room-actions";
import { createAgentSharedState, createDefaultWorkspaceState, createRoomMessage } from "@/lib/chat/workspace-domain";
import { runRoomCommand } from "@/lib/server/room-service";

test("runRoomCommand send_message persists the user message and waits for server scheduling", async () => {
  let state = createDefaultWorkspaceState();
  state.rooms = [addAgentParticipantToRoom({ room: state.rooms[0]!, agentId: "researcher" })];
  state.agentStates = {
    ...state.agentStates,
    researcher: createAgentSharedState(),
  };

  const roomId = state.rooms[0]!.id;
  const queuedRoomIds: string[] = [];
  const loadWorkspaceEnvelope = async () => ({
    version: 1,
    updatedAt: new Date().toISOString(),
    state,
  });
  const mutateWorkspace = async (mutator: (workspace: typeof state) => Promise<typeof state> | typeof state) => {
    state = await mutator(state);
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      state,
    };
  };

  const result = await runRoomCommand(
    {
      type: "send_message",
      roomId,
      content: "Please sync the room.",
      senderId: "local-operator",
    },
    {
      loadWorkspaceEnvelope,
      mutateWorkspace,
      listAgentDefinitions: async () => [],
      enqueueRoomScheduler: async (queuedRoomId) => {
        queuedRoomIds.push(queuedRoomId);
        state = {
          ...state,
          rooms: state.rooms.map((room) => {
            if (room.id !== queuedRoomId) {
              return room;
            }

            return {
              ...room,
              roomMessages: [
                ...room.roomMessages,
                createRoomMessage(room.id, "assistant", "Server scheduler finished the handoff.", "agent_emit", {
                  sender: {
                    id: "concierge",
                    name: "Harbor Concierge",
                    role: "participant",
                  },
                }),
              ],
            };
          }),
        };
      },
    },
  );

  assert.deepEqual(queuedRoomIds, [roomId]);
  assert.equal(result.room?.roomMessages.some((message) => message.content === "Please sync the room."), true);
  assert.equal(result.room?.roomMessages.some((message) => message.content === "Server scheduler finished the handoff."), true);
});
