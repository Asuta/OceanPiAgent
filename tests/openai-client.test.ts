import assert from "node:assert/strict";
import test from "node:test";
import { shouldApplyPostToolBatchCompaction } from "@/lib/ai/post-tool-compaction";
import { extractRoomMessagePreviewFromToolArgs, extractRoomMessagePreviewFromToolCallBlock } from "@/lib/ai/room-message-preview";
import { roomMessageArgsSchema } from "@/lib/ai/tools/shared";

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

test("roomMessageArgsSchema defaults send_message_to_room deliveries to non-final", () => {
  const parsed = roomMessageArgsSchema.parse({
    roomId: "room-1",
    content: "Checking now.",
    kind: "progress",
    status: "completed",
  });

  assert.equal(parsed.final, false);
});

test("roomMessageArgsSchema preserves explicit final room deliveries", () => {
  const parsed = roomMessageArgsSchema.parse({
    roomId: "room-1",
    content: "All done.",
    final: true,
  });

  assert.equal(parsed.final, true);
});

test("shouldApplyPostToolBatchCompaction skips compaction after final room delivery is armed", () => {
  assert.equal(
    shouldApplyPostToolBatchCompaction({
      pendingPostToolBatchCompaction: true,
      hasPostToolBatchCompactionHandler: true,
      finalRoomDeliveryShortCircuitArmed: true,
    }),
    false,
  );
});

test("shouldApplyPostToolBatchCompaction still allows normal post-tool compaction", () => {
  assert.equal(
    shouldApplyPostToolBatchCompaction({
      pendingPostToolBatchCompaction: true,
      hasPostToolBatchCompactionHandler: true,
      finalRoomDeliveryShortCircuitArmed: false,
    }),
    true,
  );
});
