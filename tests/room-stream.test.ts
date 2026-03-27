import assert from "node:assert/strict";
import test from "node:test";
import { readRoomStream } from "@/components/workspace/room-stream";
import type { AgentRoomTurn, RoomMessage, ToolExecution } from "@/lib/chat/types";

function createRoomMessage(overrides?: Partial<RoomMessage>): RoomMessage {
  return {
    id: "message-1",
    roomId: "room-1",
    seq: 1,
    role: "assistant",
    sender: {
      id: "concierge",
      name: "Harbor Concierge",
      role: "participant",
    },
    content: "Visible reply",
    attachments: [],
    source: "agent_emit",
    kind: "answer",
    status: "completed",
    final: true,
    createdAt: "2026-03-26T00:00:00.000Z",
    receipts: [],
    receiptStatus: "none",
    receiptUpdatedAt: null,
    ...overrides,
  };
}

function createToolExecution(): ToolExecution {
  return {
    id: "tool-1",
    sequence: 0,
    toolName: "send_message_to_room",
    displayName: "Send Message To Room",
    inputSummary: "{}",
    inputText: "{}",
    resultPreview: "sent",
    outputText: "sent",
    status: "success",
    durationMs: 1,
  };
}

function createTurn(emittedMessage: RoomMessage): AgentRoomTurn {
  return {
    id: "turn-1",
    agent: {
      id: "concierge",
      label: "Harbor Concierge",
    },
    userMessage: createRoomMessage({
      id: "user-1",
      role: "system",
      sender: {
        id: "room-scheduler",
        name: "Room Scheduler",
        role: "system",
      },
      source: "system",
      kind: "system",
      content: "Scheduler packet",
    }),
    assistantContent: "",
    tools: [createToolExecution()],
    emittedMessages: [emittedMessage],
    status: "completed",
  };
}

function createSseResponse(body: string): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
      },
    },
  );
}

test("readRoomStream processes a trailing done event without a final separator", async () => {
  const tool = createToolExecution();
  const emittedMessage = createRoomMessage();
  const turn = createTurn(emittedMessage);
  const events = [
    `data: ${JSON.stringify({ type: "tool", tool })}`,
    "",
    `data: ${JSON.stringify({ type: "room-message", message: emittedMessage })}`,
    "",
    `data: ${JSON.stringify({ type: "done", turn, resolvedModel: "gpt-5.4", compatibility: { providerKey: "generic", providerLabel: "Generic", baseUrl: "https://example.test/v1", chatCompletionsToolStyle: "tools", responsesContinuation: "replay", responsesPayloadMode: "json", notes: [] } })}`,
  ].join("\n");

  const seenTools: ToolExecution[] = [];
  const seenMessages: RoomMessage[] = [];
  const seenDone: AgentRoomTurn[] = [];

  const result = await readRoomStream({
    response: createSseResponse(events),
    shouldContinue: () => true,
    onTextDelta: () => undefined,
    onTool: (nextTool) => seenTools.push(nextTool),
    onRoomMessage: (message) => seenMessages.push(message),
    onReceiptUpdate: () => undefined,
    onDone: (event) => seenDone.push(event.turn),
    onMeta: () => undefined,
  });

  assert.equal(seenTools.length, 1);
  assert.equal(seenMessages.length, 1);
  assert.equal(seenDone.length, 1);
  assert.equal(result.emittedMessages.length, 1);
  assert.equal(result.emittedMessages[0]?.id, emittedMessage.id);
});
