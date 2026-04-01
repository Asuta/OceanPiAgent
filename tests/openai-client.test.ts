import assert from "node:assert/strict";
import test from "node:test";
import { extractRoomMessagePreviewFromToolArgs, extractRoomMessagePreviewFromToolCallBlock } from "@/lib/ai/room-message-preview";

test("extractRoomMessagePreviewFromToolArgs builds a send_message preview from partial tool args", () => {
  const preview = extractRoomMessagePreviewFromToolArgs("tool-1", "send_message_to_room", {
    roomId: "room-1",
    messageKey: "reply",
    content: "Hello wor",
    kind: "answer",
  });

  assert.deepEqual(preview, {
    toolCallId: "tool-1",
    roomId: "room-1",
    messageKey: "reply",
    content: "Hello wor",
    kind: "answer",
    status: "streaming",
    final: false,
  });
});

test("extractRoomMessagePreviewFromToolArgs parses previews from streaming JSON argument chunks", () => {
  const preview = extractRoomMessagePreviewFromToolArgs(
    "tool-1",
    "send_message_to_room",
    '{"roomId":"room-1","messageKey":"reply","content":"Hello wor',
  );

  assert.deepEqual(preview, {
    toolCallId: "tool-1",
    roomId: "room-1",
    messageKey: "reply",
    content: "Hello wor",
    kind: "answer",
    status: "streaming",
    final: false,
  });
});

test("extractRoomMessagePreviewFromToolArgs ignores unrelated tool calls and incomplete args", () => {
  assert.equal(extractRoomMessagePreviewFromToolArgs("tool-1", "bash", { command: "pwd" }), null);
  assert.equal(extractRoomMessagePreviewFromToolArgs("tool-1", "send_message_to_room", { content: "hi" }), null);
  assert.equal(extractRoomMessagePreviewFromToolArgs("tool-1", "send_message_to_room", '{"content":"hi"'), null);
});

test("extractRoomMessagePreviewFromToolCallBlock prefers raw partialJson over parsed arguments", () => {
  const preview = extractRoomMessagePreviewFromToolCallBlock({
    id: "tool-1",
    name: "send_message_to_room",
    arguments: {
      roomId: "room-1",
    },
    partialJson: '{"roomId":"room-1","content":"Hello wor',
  });

  assert.deepEqual(preview, {
    toolCallId: "tool-1",
    roomId: "room-1",
    content: "Hello wor",
    kind: "answer",
    status: "streaming",
    final: false,
  });
});
