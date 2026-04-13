import { runPreparedRoomTurn } from "@/lib/server/room-runner";

async function main() {
  const lineCount = Number(process.argv[2] ?? "25") || 25;
  const longRoomText = Array.from(
    { length: lineCount },
    (_, index) => `Line ${index + 1}: This is a longer visible room reply used for tail timing diagnostics.`,
  ).join("\n");

  const result = await runPreparedRoomTurn({
    turnId: `tail-diagnostic-turn-${Date.now()}`,
    message: {
      id: `tail-diagnostic-user-msg-${Date.now()}`,
      content: "Please produce a longer room-visible reply for timing diagnostics.",
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
      memoryBackend: "sqlite-fts",
      maxToolLoopSteps: 4,
      thinkingLevel: "off",
      enabledSkillIds: [],
    },
    room: {
      id: "tail-diagnostic-room",
      title: "Tail Diagnostic Room",
    },
    attachedRooms: [
      {
        id: "tail-diagnostic-room",
        title: "Tail Diagnostic Room",
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
    knownAgents: [],
    roomHistoryById: {
      "tail-diagnostic-room": [],
    },
    agent: {
      id: "concierge",
      label: "Harbor Concierge",
      instruction: "Keep it short.",
    },
    conversationRunner: async (_messages, _settings, callbacks) => {
      const toolEvent = {
        id: "tool-tail-final",
        sequence: 1,
        toolName: "send_message_to_room",
        displayName: "Send Message To Room",
        inputSummary: "send",
        inputText: JSON.stringify({
          roomId: "tail-diagnostic-room",
          content: longRoomText,
          kind: "answer",
          status: "completed",
          final: true,
        }),
        resultPreview: "sent",
        outputText: "sent",
        status: "success" as const,
        durationMs: 1,
        roomMessage: {
          roomId: "tail-diagnostic-room",
          content: longRoomText,
          kind: "answer" as const,
          status: "completed" as const,
          final: true,
        },
      };
      callbacks?.onTool?.(toolEvent);

      return {
        assistantText: "",
        toolEvents: [toolEvent],
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

  console.log(JSON.stringify({
    turnStatus: result.turn.status,
    emittedMessages: result.emittedMessages.length,
    assistantChars: result.turn.assistantContent.length,
    roomMessageChars: result.emittedMessages[0]?.content.length ?? 0,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
