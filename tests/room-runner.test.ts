import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createKnownAgentCards } from "@/lib/chat/workspace-domain";
import type { AssistantMessageMeta, MessageImageAttachment } from "@/lib/chat/types";
import { resetAgentRoomSession } from "@/lib/server/agent-room-sessions";
import { runPreparedRoomTurn } from "@/lib/server/room-runner";

const TEST_IMAGE_ATTACHMENT: MessageImageAttachment = {
  id: "img-1",
  kind: "image",
  mimeType: "image/jpeg",
  filename: "test.jpg",
  sizeBytes: 1234,
  storagePath: "images/test.jpg",
  url: "/api/uploads/image/images/test.jpg",
};

type ReplayedMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: MessageImageAttachment[];
  meta?: AssistantMessageMeta;
};

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
          attachments: [],
          sender: {
            id: "local-user",
            name: "You",
            role: "participant",
          },
        },
        settings: {
          modelConfigId: null,
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

test("runPreparedRoomTurn keeps image attachments in persisted agent history", async () => {
  await withTempCwd(async () => {
    await runPreparedRoomTurn({
      message: {
        id: "user-msg-image",
        content: "Please remember this image",
        attachments: [TEST_IMAGE_ATTACHMENT],
        sender: {
          id: "local-user",
          name: "You",
          role: "participant",
        },
      },
      settings: {
        modelConfigId: null,
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
      conversationRunner: async () => ({
        assistantText: "Got it.",
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
      }),
    });

    let replayedMessages: ReplayedMessage[] | null = null;

    await runPreparedRoomTurn({
      message: {
        id: "user-msg-followup",
        content: "What was in the previous image?",
        attachments: [],
        sender: {
          id: "local-user",
          name: "You",
          role: "participant",
        },
      },
      settings: {
        modelConfigId: null,
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
          messageCount: 2,
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
      conversationRunner: async (messages: ReplayedMessage[]) => {
        replayedMessages = messages;
        return {
          assistantText: "Still have it.",
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
    });

    if (!replayedMessages) {
      assert.fail("Expected the second run to receive replayed messages.");
    }
    const secondRunMessages = replayedMessages as ReplayedMessage[];
    assert.ok(secondRunMessages.some((message: ReplayedMessage) => message.role === "user" && message.attachments?.[0]?.id === TEST_IMAGE_ATTACHMENT.id));

    await resetAgentRoomSession("concierge");
  });
});

test("runPreparedRoomTurn preserves assistant response metadata for future replay", async () => {
  await withTempCwd(async () => {
    await runPreparedRoomTurn({
      message: {
        id: "user-msg-cache-1",
        content: "Plan the next step",
        attachments: [],
        sender: {
          id: "local-user",
          name: "You",
          role: "participant",
        },
      },
      settings: {
        modelConfigId: null,
        apiFormat: "responses",
        model: "fake-model",
        systemPrompt: "",
        providerMode: "openai",
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
      conversationRunner: async () => ({
        assistantText: "I checked it.",
        toolEvents: [],
        resolvedModel: "openai/gpt-4.1",
        compatibility: {
          providerKey: "openai",
          providerLabel: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          chatCompletionsToolStyle: "tools",
          responsesContinuation: "previous_response_id",
          responsesPayloadMode: "json",
          notes: [],
        },
        actualApiFormat: "responses",
        responseId: "resp-cache-1",
        sessionId: "room:room-1:agent:concierge",
        continuation: {
          strategy: "replay",
        },
        usage: {
          input: 20,
          output: 8,
          cacheRead: 128,
          cacheWrite: 0,
          totalTokens: 156,
        },
        historyDelta: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "workspace_read",
                arguments: { path: "notes.txt" },
              },
            ],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-4.1",
            usage: {
              input: 10,
              output: 2,
              cacheRead: 64,
              cacheWrite: 0,
              totalTokens: 76,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "toolUse",
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "workspace_read",
            content: [
              {
                type: "text",
                text: "notes loaded",
              },
            ],
            isError: false,
            timestamp: 2,
          },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I checked it.",
              },
            ],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-4.1",
            responseId: "resp-cache-1",
            usage: {
              input: 20,
              output: 8,
              cacheRead: 128,
              cacheWrite: 0,
              totalTokens: 156,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: 3,
          },
        ],
      }),
    });

    let replayedMessages: ReplayedMessage[] | null = null;

    await runPreparedRoomTurn({
      message: {
        id: "user-msg-cache-2",
        content: "Continue from there",
        attachments: [],
        sender: {
          id: "local-user",
          name: "You",
          role: "participant",
        },
      },
      settings: {
        modelConfigId: null,
        apiFormat: "responses",
        model: "fake-model",
        systemPrompt: "",
        providerMode: "openai",
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
          messageCount: 2,
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
      conversationRunner: async (messages: ReplayedMessage[]) => {
        replayedMessages = messages;
        return {
          assistantText: "Continuing now.",
          toolEvents: [],
          resolvedModel: "openai/gpt-4.1",
          compatibility: {
            providerKey: "openai",
            providerLabel: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            chatCompletionsToolStyle: "tools",
            responsesContinuation: "previous_response_id",
            responsesPayloadMode: "json",
            notes: [],
          },
          actualApiFormat: "responses",
        };
      },
    });

    if (!replayedMessages) {
      assert.fail("Expected the second run to receive replayed messages.");
    }

    const replayedMessagesList = replayedMessages as ReplayedMessage[];
    const replayedAssistant = replayedMessagesList.find((message: ReplayedMessage) => message.role === "assistant" && message.meta?.responseId === "resp-cache-1");
    assert.ok(replayedAssistant);
    assert.equal(replayedAssistant?.meta?.sessionId, "room:room-1:agent:concierge");
    assert.equal(replayedAssistant?.meta?.usage?.cacheRead, 128);
    assert.equal(replayedAssistant?.meta?.historyDelta?.length, 3);
    assert.equal(replayedAssistant?.meta?.historyDelta?.[1]?.role, "toolResult");

    await resetAgentRoomSession("concierge");
  });
});
