import type {
  AssistantMessageMeta,
  RoomChatStreamEvent,
  RoomMessage,
  RoomMessageReceiptUpdate,
  ToolExecution,
} from "@/lib/chat/types";

function extractNextBlock(buffer: string): { block: string; rest: string } | null {
  const separatorMatch = buffer.match(/\r?\n\r?\n/);
  if (!separatorMatch || separatorMatch.index === undefined) {
    return null;
  }

  return {
    block: buffer.slice(0, separatorMatch.index),
    rest: buffer.slice(separatorMatch.index + separatorMatch[0].length),
  };
}

function parseRoomStreamBlock(block: string): RoomChatStreamEvent | null {
  const dataLines = block
    .split(/\r?\n/g)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return null;
  }

  try {
    return JSON.parse(dataLines.join("\n")) as RoomChatStreamEvent;
  } catch {
    return null;
  }
}

function handleRoomStreamEvent(
  event: RoomChatStreamEvent,
  args: Omit<Parameters<typeof readRoomStream>[0], "response">,
  emittedMessages: RoomMessage[],
  receiptUpdates: RoomMessageReceiptUpdate[],
): void {
  if (event.type === "agent-text-delta") {
    args.onTextDelta(event.delta);
    return;
  }

  if (event.type === "tool") {
    args.onTool(event.tool);
    return;
  }

  if (event.type === "room-message-preview") {
    args.onRoomMessagePreview(event.message);
    return;
  }

  if (event.type === "room-message") {
    emittedMessages.push(event.message);
    args.onRoomMessage(event.message);
    return;
  }

  if (event.type === "message-receipt") {
    receiptUpdates.push(event.update);
    args.onReceiptUpdate(event.update);
    return;
  }

  if (event.type === "done") {
    args.onDone(event);
    return;
  }

  if (event.meta) {
    args.onMeta(event.meta);
  }
  throw new Error(event.error);
}

export async function readRoomStream(args: {
  response: Response;
  shouldContinue: () => boolean;
  onTextDelta: (delta: string) => void;
  onTool: (tool: ToolExecution) => void;
  onRoomMessagePreview: (message: RoomMessage) => void;
  onRoomMessage: (message: RoomMessage) => void;
  onReceiptUpdate: (update: RoomMessageReceiptUpdate) => void;
  onDone: (event: Extract<RoomChatStreamEvent, { type: "done" }>) => void;
  onMeta: (meta: AssistantMessageMeta) => void;
}): Promise<{
  emittedMessages: RoomMessage[];
  receiptUpdates: RoomMessageReceiptUpdate[];
}> {
  const reader = args.response.body?.getReader();
  if (!reader) {
    throw new Error("The room stream did not contain a readable body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const emittedMessages: RoomMessage[] = [];
  const receiptUpdates: RoomMessageReceiptUpdate[] = [];

  while (true) {
    const { value, done } = await reader.read();

    if (!args.shouldContinue()) {
      await reader.cancel().catch(() => undefined);
      return { emittedMessages, receiptUpdates };
    }

    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    while (true) {
      const nextBlock = extractNextBlock(buffer);
      if (!nextBlock) {
        break;
      }

      buffer = nextBlock.rest;
      const event = parseRoomStreamBlock(nextBlock.block);
      if (!event) {
        continue;
      }

      if (!args.shouldContinue()) {
        await reader.cancel().catch(() => undefined);
        return { emittedMessages, receiptUpdates };
      }

      handleRoomStreamEvent(event, args, emittedMessages, receiptUpdates);
    }

    if (done) {
      break;
    }
  }

  if (!args.shouldContinue()) {
    return { emittedMessages, receiptUpdates };
  }

  const trailingEvent = parseRoomStreamBlock(buffer);
  if (trailingEvent) {
    handleRoomStreamEvent(trailingEvent, args, emittedMessages, receiptUpdates);
  }

  return { emittedMessages, receiptUpdates };
}
