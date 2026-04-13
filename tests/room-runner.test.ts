import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createKnownAgentCards } from "@/lib/chat/workspace-domain";
import type { AssistantMessageMeta, MessageImageAttachment } from "@/lib/chat/types";
import { closeLcmDatabase } from "@/lib/server/lcm/db";
import {
  clearActiveAgentRoomRunForRoom,
  hasActiveAgentRoomRun,
  resetAgentRoomSession,
  startAgentRoomRun,
} from "@/lib/server/agent-room-sessions";
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
    await closeLcmDatabase();
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
    assert.equal(result.turn.draftSegments?.length, 1);
    assert.equal(result.turn.draftSegments?.[0]?.content, "Done. ");
    assert.deepEqual(
      result.turn.timeline?.map((event) => event.type),
      ["draft-segment", "tool", "room-message", "tool"],
    );

    await resetAgentRoomSession("concierge");
  });
});

test("clearing a timed-out active run prevents stale continuation from leaking into the next room", async () => {
  await withTempCwd(async () => {
    await resetAgentRoomSession("concierge");

    const firstController = new AbortController();
    await startAgentRoomRun({
      agentId: "concierge",
      roomId: "room-stale",
      roomTitle: "Stale Room",
      attachedRooms: [],
      userMessageId: "stale-user-msg",
      userSender: {
        id: "local-user",
        name: "You",
        role: "participant",
      },
      userContent: "Old unfinished task",
      userAttachments: [],
      requestSignal: firstController.signal,
    });

    assert.equal(hasActiveAgentRoomRun("concierge"), true);

    clearActiveAgentRoomRunForRoom("concierge", "room-stale", "Timed out for test.");

    assert.equal(hasActiveAgentRoomRun("concierge"), false);

    const secondController = new AbortController();
    const nextRun = await startAgentRoomRun({
      agentId: "concierge",
      roomId: "room-fresh",
      roomTitle: "Fresh Room",
      attachedRooms: [],
      userMessageId: "fresh-user-msg",
      userSender: {
        id: "local-user",
        name: "You",
        role: "participant",
      },
      userContent: "New task",
      userAttachments: [],
      requestSignal: secondController.signal,
    });

    assert.equal(nextRun.continuationSnapshot, undefined);

    clearActiveAgentRoomRunForRoom("concierge", "room-fresh", "Cleanup.");
    await resetAgentRoomSession("concierge");
  });
});

test("an externally aborted active run does not leak a continuation snapshot into the next room", async () => {
  await withTempCwd(async () => {
    await resetAgentRoomSession("concierge");

    const firstController = new AbortController();
    await startAgentRoomRun({
      agentId: "concierge",
      roomId: "room-aborted",
      roomTitle: "Aborted Room",
      attachedRooms: [],
      userMessageId: "aborted-user-msg",
      userSender: {
        id: "local-user",
        name: "You",
        role: "participant",
      },
      userContent: "Old aborted task",
      userAttachments: [],
      requestSignal: firstController.signal,
    });

    firstController.abort(new Error("Timed out for test."));

    const secondController = new AbortController();
    const nextRun = await startAgentRoomRun({
      agentId: "concierge",
      roomId: "room-fresh-after-abort",
      roomTitle: "Fresh Room After Abort",
      attachedRooms: [],
      userMessageId: "fresh-user-msg-after-abort",
      userSender: {
        id: "local-user",
        name: "You",
        role: "participant",
      },
      userContent: "New task",
      userAttachments: [],
      requestSignal: secondController.signal,
    });

    assert.equal(nextRun.continuationSnapshot, undefined);
    clearActiveAgentRoomRunForRoom("concierge", "room-fresh-after-abort", "Cleanup.");
    await resetAgentRoomSession("concierge");
  });
});

test("runPreparedRoomTurn keeps repeated send_message calls as separate bubbles even with the same message key", async () => {
  await withTempCwd(async () => {
    const seenMessages: string[] = [];
    const result = await runPreparedRoomTurn(
      {
        message: {
          id: "user-msg-stream",
          content: "Stream it",
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
            participants: [],
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
              messageKey: "reply",
              content: "Visible",
              kind: "answer",
              status: "streaming",
              final: false,
            },
          });
          callbacks?.onTool?.({
            id: "tool-2",
            sequence: 2,
            toolName: "send_message_to_room",
            displayName: "Send Message To Room",
            inputSummary: "send",
            inputText: "{}",
            resultPreview: "sent",
            outputText: "sent",
            status: "success",
            durationMs: 10,
            roomMessage: {
              roomId: "room-1",
              messageKey: "reply",
              content: "Visible answer",
              kind: "answer",
              status: "completed",
              final: true,
            },
          });

          return {
            assistantText: "Done.",
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
        onRoomMessage: (message) => seenMessages.push(`${message.id}:${message.status}:${message.content}`),
      },
    );

    assert.equal(result.emittedMessages.length, 2);
    assert.equal(result.emittedMessages[0]?.content, "Visible");
    assert.equal(result.emittedMessages[0]?.status, "streaming");
    assert.equal(result.emittedMessages[1]?.content, "Visible answer");
    assert.equal(result.emittedMessages[1]?.status, "completed");
    assert.equal(result.turn.emittedMessages.length, 2);
    assert.equal(result.turn.draftSegments?.length ?? 0, 0);
    assert.deepEqual(
      result.turn.timeline?.map((event) => event.type),
      ["tool", "room-message", "tool", "room-message"],
    );
    assert.equal(seenMessages.length, 2);
    assert.notEqual(seenMessages[0]?.split(":")[0], seenMessages[1]?.split(":")[0]);

    await resetAgentRoomSession("concierge");
  });
});

test("runPreparedRoomTurn splits draft segments when tool calls interrupt generation", async () => {
  await withTempCwd(async () => {
    const result = await runPreparedRoomTurn({
      message: {
        id: "user-msg-draft-split",
        content: "Split drafts",
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
          participants: [],
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
        callbacks?.onTextDelta?.("First draft. ");
        callbacks?.onTool?.({
          id: "tool-split-1",
          sequence: 1,
          toolName: "webfetch",
          displayName: "Web Fetch",
          inputSummary: "fetch",
          inputText: "{}",
          resultPreview: "ok",
          outputText: "ok",
          status: "success",
          durationMs: 10,
        });
        callbacks?.onTextDelta?.("Second draft. ");

        return {
          assistantText: "Second draft.",
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

    assert.deepEqual(
      result.turn.draftSegments?.map((segment) => ({ content: segment.content, status: segment.status })),
      [
        { content: "First draft. ", status: "completed" },
        { content: "Second draft. ", status: "completed" },
      ],
    );
    assert.deepEqual(
      result.turn.timeline?.map((event) => event.type),
      ["draft-segment", "tool", "draft-segment"],
    );

    await resetAgentRoomSession("concierge");
  });
});

test("runPreparedRoomTurn keeps preview and final send_message room bubbles on the same id without messageKey", async () => {
  await withTempCwd(async () => {
    const previewIds: string[] = [];
    const finalIds: string[] = [];

    const result = await runPreparedRoomTurn(
      {
        message: {
          id: "user-msg-preview-stream",
          content: "Preview this",
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
            participants: [],
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
          callbacks?.onRoomMessagePreview?.({
            toolCallId: "tool-preview-1",
            roomId: "room-1",
            content: "Hello wor",
            kind: "answer",
            status: "streaming",
            final: false,
          });
          callbacks?.onTool?.({
            id: "tool-preview-1",
            sequence: 1,
            toolName: "send_message_to_room",
            displayName: "Send Message To Room",
            inputSummary: "send",
            inputText: "{}",
            resultPreview: "sent",
            outputText: "sent",
            status: "success",
            durationMs: 10,
            roomMessage: {
              roomId: "room-1",
              content: "Hello world",
              kind: "answer",
              status: "completed",
              final: true,
            },
          });

          return {
            assistantText: "Done.",
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
        onRoomMessagePreview: (message) => previewIds.push(message.id),
        onRoomMessage: (message) => finalIds.push(message.id),
      },
    );

    assert.equal(previewIds.length, 1);
    assert.equal(finalIds.length, 1);
    assert.equal(previewIds[0], finalIds[0]);
    assert.equal(result.emittedMessages[0]?.id, finalIds[0]);

    await resetAgentRoomSession("concierge");
  });
});

test("runPreparedRoomTurn keeps separate send_message calls as separate ordered bubbles", async () => {
  await withTempCwd(async () => {
    const seenMessageIds: string[] = [];

    const result = await runPreparedRoomTurn(
      {
        message: {
          id: "user-msg-two-room-messages",
          content: "Two messages",
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
            participants: [],
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
          callbacks?.onRoomMessagePreview?.({
            toolCallId: "tool-preview-a",
            roomId: "room-1",
            content: "First",
            kind: "progress",
            status: "streaming",
            final: false,
          });
          callbacks?.onTool?.({
            id: "tool-preview-a",
            sequence: 1,
            toolName: "send_message_to_room",
            displayName: "Send Message To Room",
            inputSummary: "send",
            inputText: "{}",
            resultPreview: "sent",
            outputText: "sent",
            status: "success",
            durationMs: 10,
            roomMessage: {
              roomId: "room-1",
              content: "First message",
              kind: "progress",
              status: "completed",
              final: false,
            },
          });
          callbacks?.onRoomMessagePreview?.({
            toolCallId: "tool-preview-b",
            roomId: "room-1",
            content: "Second",
            kind: "answer",
            status: "streaming",
            final: false,
          });
          callbacks?.onTool?.({
            id: "tool-preview-b",
            sequence: 2,
            toolName: "send_message_to_room",
            displayName: "Send Message To Room",
            inputSummary: "send",
            inputText: "{}",
            resultPreview: "sent",
            outputText: "sent",
            status: "success",
            durationMs: 10,
            roomMessage: {
              roomId: "room-1",
              content: "Second message",
              kind: "answer",
              status: "completed",
              final: true,
            },
          });

          return {
            assistantText: "Done.",
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
        onRoomMessage: (message) => seenMessageIds.push(message.id),
      },
    );

    assert.equal(result.emittedMessages.length, 2);
    assert.deepEqual(result.emittedMessages.map((message) => message.content), ["First message", "Second message"]);
    assert.deepEqual(result.turn.timeline?.map((event) => event.type), ["tool", "room-message", "tool", "room-message"]);
    assert.equal(seenMessageIds.length, 2);
    assert.notEqual(seenMessageIds[0], seenMessageIds[1]);

    await resetAgentRoomSession("concierge");
  });
});

test("runPreparedRoomTurn does not bridge ordinary assistant text into a send_message_to_room bubble", async () => {
  await withTempCwd(async () => {
    const previewContents: string[] = [];
    const finalMessages: string[] = [];

    const result = await runPreparedRoomTurn(
      {
        message: {
          id: "user-msg-visible-stream",
          content: "Please stream the visible room reply.",
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
            participants: [],
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
          callbacks?.onTool?.({
            id: "tool-stream-begin",
            sequence: 1,
            toolName: "send_message_to_room",
            displayName: "Send Message To Room",
            inputSummary: "send",
            inputText: "{}",
            resultPreview: "sent",
            outputText: "sent",
            status: "success",
            durationMs: 5,
            roomMessage: {
              roomId: "room-1",
              kind: "progress",
              content: "Hello",
              status: "streaming",
              final: false,
            },
          });
          callbacks?.onTool?.({
            id: "tool-stream-mid",
            sequence: 2,
            toolName: "custom_command",
            displayName: "Custom Command · current_time",
            inputSummary: "time",
            inputText: "{}",
            resultPreview: "time",
            outputText: "time",
            status: "success",
            durationMs: 7,
          });
          callbacks?.onTextDelta?.(" world");

          return {
            assistantText: "Hello world",
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
        onRoomMessagePreview: (message) => previewContents.push(message.content),
        onRoomMessage: (message) => finalMessages.push(`${message.id}:${message.status}:${message.content}`),
      },
    );

    assert.deepEqual(previewContents, []);
    assert.equal(result.emittedMessages.length, 1);
    assert.equal(result.emittedMessages[0]?.content, "Hello");
    assert.equal(result.emittedMessages[0]?.status, "streaming");
    assert.equal(result.emittedMessages[0]?.kind, "progress");
    assert.equal(result.turn.draftSegments?.length ?? 0, 1);
    assert.equal(result.turn.draftSegments?.[0]?.content, " world");
    assert.deepEqual(result.turn.timeline?.map((event) => event.type), ["tool", "room-message", "tool", "draft-segment"]);
    assert.equal(finalMessages.length, 1);
    assert.match(finalMessages[0] ?? "", /streaming:Hello$/);

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
