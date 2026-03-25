import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createKnownAgentCards } from "@/lib/chat/workspace-domain";
import { resetAgentRoomSession } from "@/lib/server/agent-room-sessions";
import { runPreparedRoomTurn } from "@/lib/server/room-runner";

async function withTempCwd(run: () => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oceanking-room-runner-test-"));
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    await run();
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("runPreparedRoomTurn streams tool side effects and returns final room result", async () => {
  await withTempCwd(async () => {
    const callbackEvents: string[] = [];
    const result = await runPreparedRoomTurn(
      {
        message: {
          id: "user-msg-1",
          content: "Please check this quickly",
          sender: {
            id: "local-user",
            name: "You",
            role: "participant",
          },
        },
        settings: {
          apiFormat: "chat_completions",
          model: "fake-model",
          systemPrompt: "",
          providerMode: "auto",
          maxToolLoopSteps: 4,
          thinkingLevel: "off",
          enabledSkillIds: [],
        },
        room: {
          id: "room-1",
          title: "Primary Room",
        },
        attachedRooms: [
          {
            id: "room-1",
            title: "Primary Room",
            archived: false,
            ownerParticipantId: "concierge",
            ownerName: "Harbor Concierge",
            currentAgentMembershipRole: "owner",
            currentAgentIsOwner: true,
            participants: [
              {
                participantId: "concierge",
                name: "Harbor Concierge",
                runtimeKind: "agent",
                membershipRole: "owner",
                enabled: true,
                agentId: "concierge",
              },
              {
                participantId: "local-user",
                name: "You",
                runtimeKind: "human",
                membershipRole: "member",
                enabled: true,
              },
            ],
            messageCount: 1,
            latestMessageAt: null,
          },
        ],
        knownAgents: createKnownAgentCards(),
        roomHistoryById: {
          "room-1": [],
        },
        agent: {
          id: "concierge",
          label: "Harbor Concierge",
          instruction: "Keep it short.",
        },
        conversationRunner: async (_messages, _settings, callbacks) => {
          callbacks?.onTextDelta?.("Done. ");
          callbacks?.onTool?.({
            id: "tool-1",
            sequence: 1,
            toolName: "send_message_to_room",
            displayName: "Send Message To Room",
            inputSummary: "send",
            inputText: "{}",
            resultPreview: "sent",
            outputText: "sent",
            status: "success",
            durationMs: 12,
            roomMessage: {
              roomId: "room-1",
              content: "Visible answer",
              kind: "answer",
              status: "completed",
              final: true,
            },
          });
          callbacks?.onTool?.({
            id: "tool-2",
            sequence: 2,
            toolName: "read_no_reply",
            displayName: "Read No Reply",
            inputSummary: "receipt",
            inputText: "{}",
            resultPreview: "marked",
            outputText: "marked",
            status: "success",
            durationMs: 8,
            roomAction: {
              type: "read_no_reply",
              roomId: "room-1",
              messageId: "user-msg-1",
            },
          });

          return {
            assistantText: "Done. Internal note.",
            toolEvents: [],
            resolvedModel: "fake-provider/fake-model",
            compatibility: {
              providerKey: "generic",
              providerLabel: "Generic",
              baseUrl: "https://example.test/v1",
              chatCompletionsToolStyle: "tools",
              responsesContinuation: "replay",
              responsesPayloadMode: "json",
              notes: [],
            },
            actualApiFormat: "chat_completions",
          };
        },
      },
      {
        onTextDelta: () => callbackEvents.push("text"),
        onTool: () => callbackEvents.push("tool"),
        onRoomMessage: () => callbackEvents.push("room-message"),
        onReceiptUpdate: () => callbackEvents.push("receipt"),
      },
    );

    assert.deepEqual(callbackEvents, ["text", "tool", "room-message", "tool", "receipt"]);
    assert.equal(result.turn.status, "completed");
    assert.equal(result.turn.assistantContent, "Done. Internal note.");
    assert.equal(result.emittedMessages.length, 1);
    assert.equal(result.receiptUpdates.length, 1);
    assert.equal(result.roomActions.length, 1);
    assert.equal(result.turn.userMessage.receiptStatus, "read_no_reply");
    assert.equal(result.turn.userMessage.receipts.length, 1);

    await resetAgentRoomSession("concierge");
  });
});
