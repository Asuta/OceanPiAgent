import assert from "node:assert/strict";
import test from "node:test";
import * as postToolContextCache from "@/lib/ai/post-tool-context-cache";
import { shouldApplyPostToolBatchCompaction } from "@/lib/ai/post-tool-compaction";
import { __testing as postToolStallTesting } from "@/lib/ai/post-tool-stall";
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

test("cached post-tool compaction state reuses the compacted prefix for later tool loops", () => {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  const firstRawMessages = [
    {
      role: "user" as const,
      content: "Earlier room request",
      timestamp: 1,
    },
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Earlier answer" }],
      api: "responses" as const,
      provider: "openai",
      model: "fake-model",
      usage,
      stopReason: "stop" as const,
      timestamp: 2,
    },
    {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: "tool-1", name: "web_fetch", arguments: { url: "https://example.com/1" } }],
      api: "responses" as const,
      provider: "openai",
      model: "fake-model",
      usage,
      stopReason: "toolUse" as const,
      timestamp: 3,
    },
    {
      role: "toolResult" as const,
      toolCallId: "tool-1",
      toolName: "web_fetch",
      content: [{ type: "text" as const, text: "tool output" }],
      isError: false,
      timestamp: 4,
    },
  ];
  const compactedMessages = [
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "## 关键结论\n- 已压缩" }],
      api: "responses" as const,
      provider: "openai",
      model: "fake-model",
      usage,
      stopReason: "stop" as const,
      timestamp: 2,
    },
    ...firstRawMessages.slice(2),
  ];
  const state = postToolContextCache.createPostToolCompactedContextState({
    rawMessages: firstRawMessages,
    effectiveMessages: compactedMessages,
    rawMessageSignatures: ["m1", "m2", "m3", "m4"],
  });
  const secondRawMessages = [
    ...firstRawMessages,
    {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: "tool-2", name: "web_fetch", arguments: { url: "https://example.com/2" } }],
      api: "responses" as const,
      provider: "openai",
      model: "fake-model",
      usage,
      stopReason: "toolUse" as const,
      timestamp: 5,
    },
    {
      role: "toolResult" as const,
      toolCallId: "tool-2",
      toolName: "web_fetch",
      content: [{ type: "text" as const, text: "second tool output" }],
      isError: false,
      timestamp: 6,
    },
  ];

  const applied = postToolContextCache.applyPostToolCompactedContextState({
    messages: secondRawMessages,
    state,
    rawMessageSignatures: ["m1", "m2", "m3", "m4", "m5", "m6"],
  });

  assert.equal(applied.cacheApplied, true);
  assert.equal(applied.effectiveMessages.length, 5);
  assert.deepEqual(applied.effectiveMessages, [
    ...compactedMessages,
    ...secondRawMessages.slice(firstRawMessages.length),
  ]);
});

test("post-tool stall watchdog pauses during compaction and resumes afterward", async () => {
  let abortCount = 0;
  const stallAbort = postToolStallTesting.createPostToolStallAbortController({
    abort: () => {
      abortCount += 1;
    },
    getStallMs: () => 25,
  });

  stallAbort.arm({
    id: "tool-1",
    sequence: 1,
    toolName: "send_message_to_room",
    displayName: "Send Message To Room",
    inputSummary: "",
    inputText: "",
    resultPreview: "",
    outputText: "",
    status: "success",
    durationMs: 1,
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  stallAbort.pause();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(abortCount, 0);
  assert.equal(stallAbort.getMessage(), "");

  stallAbort.resume();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(abortCount, 1);
  assert.match(stallAbort.getMessage(), /Model stalled for 25 ms after completing tool Send Message To Room\./);

  stallAbort.clear();
});

test("tool-call stall watchdog aborts when a tool call stops streaming", async () => {
  let abortCount = 0;
  const stallAbort = postToolStallTesting.createToolCallStallAbortController({
    abort: () => {
      abortCount += 1;
    },
    getStallMs: () => 25,
  });

  stallAbort.arm("send_message_to_room");
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(abortCount, 1);
  assert.match(stallAbort.getMessage(), /Model stalled for 25 ms while streaming tool Send Message To Room\./);

  stallAbort.clear();
});

test("post-tool compaction timeout controller aborts the nested compaction request", async () => {
  const timeout = postToolStallTesting.createPostToolCompactionTimeoutController({
    getTimeoutMs: () => 25,
  });

  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(timeout.signal.aborted, true);
  assert.equal(timeout.timedOut(), true);
  assert.match(timeout.getMessage(), /Post-tool compaction timed out after 25 ms\./);

  timeout.clear();
});
