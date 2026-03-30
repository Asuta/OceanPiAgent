import assert from "node:assert/strict";
import test from "node:test";
import { addAgentParticipantToRoom } from "@/lib/chat/room-actions";
import { appendMessageToRoom, createAgentSharedState, createDefaultWorkspaceState, createRoomMessage } from "@/lib/chat/workspace-domain";
import type { RunRoomTurnResult } from "@/lib/server/room-runner";
import { runRoomSchedulerNow } from "@/lib/server/room-scheduler";

test("runRoomSchedulerNow advances multi-agent room work on the server and settles idle", async () => {
  let state = createDefaultWorkspaceState();
  let room = addAgentParticipantToRoom({ room: state.rooms[0]!, agentId: "researcher" });
  const inboundMessage = createRoomMessage(room.id, "user", "Team, please coordinate.", "user", {
    sender: {
      id: "local-operator",
      name: "You",
      role: "participant",
    },
  });
  room = appendMessageToRoom(room, inboundMessage);
  state = {
    ...state,
    rooms: [room],
    agentStates: {
      ...state.agentStates,
      researcher: createAgentSharedState(),
    },
  };

  const callOrder: string[] = [];
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

  await runRoomSchedulerNow(room.id, {
    loadWorkspaceEnvelope,
    mutateWorkspace,
    runRoomTurnNonStreaming: async ({ roomId, message, agentId }) => {
      callOrder.push(agentId);
      const emittedMessages = agentId === "concierge"
        ? [
            createRoomMessage(roomId, "assistant", "Concierge handed this to Researcher.", "agent_emit", {
              sender: {
                id: "concierge",
                name: "Harbor Concierge",
                role: "participant",
              },
            }),
          ]
        : [];

      const result: RunRoomTurnResult = {
        turn: {
          id: `turn-${agentId}`,
          agent: {
            id: agentId,
            label: agentId,
          },
          userMessage: {
            ...createRoomMessage(roomId, "system", message.content, "system", {
              sender: message.sender,
              kind: "system",
            }),
            id: message.id,
          },
          assistantContent: agentId === "concierge" ? "Passing this along." : "Research complete.",
          tools: [],
          emittedMessages,
          status: "completed",
          resolvedModel: "generic/fake-model",
        },
        resolvedModel: "generic/fake-model",
        compatibility: {
          providerKey: "generic",
          providerLabel: "Generic",
          baseUrl: "",
          chatCompletionsToolStyle: "tools",
          responsesContinuation: "replay",
          responsesPayloadMode: "json",
          notes: [],
        },
        emittedMessages,
        receiptUpdates: [],
        roomActions: [],
      };

      return result;
    },
  });

  const nextRoom = state.rooms[0]!;
  assert.deepEqual(callOrder, ["concierge", "researcher"]);
  assert.equal(nextRoom.scheduler.status, "idle");
  assert.equal(nextRoom.roomMessages.some((message) => message.content === "Concierge handed this to Researcher."), true);
  assert.equal(nextRoom.agentTurns.length, 2);
});
