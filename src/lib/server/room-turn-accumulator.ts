import type {
  AgentRoomTurn,
  DraftTextSegment,
  MessageImageAttachment,
  RoomMessage,
  RoomMessageEmission,
  RoomMessagePreviewEmission,
  RoomMessageReceipt,
  RoomMessageReceiptStatus,
  RoomMessageReceiptUpdate,
  RoomMessageStreamAction,
  RoomSender,
  RoomToolActionUnion,
  ToolExecution,
  TurnTimelineEvent,
} from "@/lib/chat/types";
import {
  appendDraftDelta,
  createToolTimelineEvent,
  finalizeLatestDraftSegment,
  upsertEmittedRoomMessageState,
} from "@/lib/server/room-turn-state";

type RoomTurnAccumulatorCallbacks = {
  onTextDelta?: (delta: string) => void;
  onTool?: (tool: ToolExecution) => void;
  onRoomMessagePreview?: (message: RoomMessage) => void;
  onRoomMessage?: (message: RoomMessage) => void;
  onReceiptUpdate?: (update: RoomMessageReceiptUpdate) => void;
};

type ActiveRoomMessageStream = {
  roomId: string;
  messageKey: string;
  message: RoomMessage;
};

export type RoomTurnAccumulatorErrorPartial = {
  agent: AgentRoomTurn["agent"];
  roomId: string;
  userMessageId: string;
  userSender: RoomSender;
  userContent: string;
  userAttachments: MessageImageAttachment[];
  anchorMessageId?: string;
  toolEvents: ToolExecution[];
  emittedMessages: RoomMessage[];
  receiptUpdates: RoomMessageReceiptUpdate[];
  draftSegments: DraftTextSegment[];
  timeline: TurnTimelineEvent[];
  currentUserReceipts: RoomMessageReceipt[];
  currentUserReceiptStatus: RoomMessageReceiptStatus;
  currentUserReceiptUpdatedAt: string | null;
  resolvedModel: string;
  continuationSnapshot?: string;
};

export function createRoomTurnAccumulator(args: {
  agent: AgentRoomTurn["agent"];
  roomId: string;
  userMessageId: string;
  userSender: RoomSender;
  userContent: string;
  userAttachments: MessageImageAttachment[];
  anchorMessageId?: string;
  resolvedModel: string;
  continuationSnapshot?: string;
  callbacks?: RoomTurnAccumulatorCallbacks;
  createEmittedRoomMessage: (preview: RoomMessageEmission, toolCallId?: string) => RoomMessage;
  createStreamControlRoomMessage: (
    args: Extract<RoomMessageStreamAction, { type: "begin_room_message_stream" | "finalize_room_message_stream" }> & { content: string },
  ) => RoomMessage;
  createReadNoReplyReceipt: (createdAt: string) => RoomMessageReceipt;
  createMessageReceiptUpdate: (roomId: string, messageId: string, receipt: RoomMessageReceipt) => RoomMessageReceiptUpdate;
  upsertReceipt: (receipts: RoomMessageReceipt[], receipt: RoomMessageReceipt) => RoomMessageReceipt[];
  createTimestamp: () => string;
}) {
  const toolEvents: ToolExecution[] = [];
  const emittedMessages: RoomMessage[] = [];
  const receiptUpdates: RoomMessageReceiptUpdate[] = [];
  const timeline: TurnTimelineEvent[] = [];
  let draftSegments: DraftTextSegment[] = [];
  let currentUserReceiptStatus: RoomMessageReceiptStatus = "none";
  let currentUserReceiptUpdatedAt: string | null = null;
  let currentUserReceipts: RoomMessageReceipt[] = [];
  let activeRoomMessageStream: ActiveRoomMessageStream | null = null;

  function handleTextDelta(delta: string) {
    if (activeRoomMessageStream) {
      const nextRoomMessage = {
        ...activeRoomMessageStream.message,
        content: `${activeRoomMessageStream.message.content}${delta}`,
        status: "streaming",
        final: false,
      } satisfies RoomMessage;
      activeRoomMessageStream = {
        ...activeRoomMessageStream,
        message: nextRoomMessage,
      };
      upsertEmittedRoomMessageState(emittedMessages, timeline, nextRoomMessage);
      args.callbacks?.onRoomMessagePreview?.(nextRoomMessage);
      return;
    }

    const nextDraftState = appendDraftDelta({
      draftSegments,
      timeline,
      delta,
    });
    draftSegments = nextDraftState.draftSegments;
    timeline.splice(0, timeline.length, ...nextDraftState.timeline);
    args.callbacks?.onTextDelta?.(delta);
  }

  function handlePreview(preview: RoomMessagePreviewEmission) {
    const previewMessage = args.createEmittedRoomMessage(
      {
        roomId: preview.roomId,
        ...(preview.messageKey ? { messageKey: preview.messageKey } : {}),
        content: preview.content,
        kind: preview.kind,
        status: "streaming",
        final: false,
      },
      preview.toolCallId,
    );
    args.callbacks?.onRoomMessagePreview?.(previewMessage);
  }

  function handleTool(tool: ToolExecution) {
    draftSegments = finalizeLatestDraftSegment(draftSegments);
    toolEvents.push(tool);
    timeline.push(createToolTimelineEvent(tool, timeline.length + 1));
    args.callbacks?.onTool?.(tool);

    if (tool.roomMessageStream?.type === "begin_room_message_stream") {
      const roomMessage = args.createStreamControlRoomMessage({
        ...tool.roomMessageStream,
        content: tool.roomMessageStream.initialContent,
      });
      activeRoomMessageStream = {
        roomId: tool.roomMessageStream.roomId,
        messageKey: tool.roomMessageStream.messageKey,
        message: roomMessage,
      };
      if (roomMessage.content) {
        upsertEmittedRoomMessageState(emittedMessages, timeline, roomMessage);
        args.callbacks?.onRoomMessage?.(roomMessage);
      }
    }

    if (tool.roomMessageStream?.type === "finalize_room_message_stream") {
      const activeStream = activeRoomMessageStream;
      const activeStreamMatches = activeStream
        && activeStream.roomId === tool.roomMessageStream.roomId
        && activeStream.messageKey === tool.roomMessageStream.messageKey;

      if (activeStreamMatches) {
        const roomMessage = args.createStreamControlRoomMessage({
          ...tool.roomMessageStream,
          content: activeStream.message.content,
        });
        activeRoomMessageStream = null;
        upsertEmittedRoomMessageState(emittedMessages, timeline, roomMessage);
        args.callbacks?.onRoomMessage?.(roomMessage);
      }
    }

    if (tool.roomMessage) {
      const roomMessage = args.createEmittedRoomMessage(tool.roomMessage, tool.id);
      upsertEmittedRoomMessageState(emittedMessages, timeline, roomMessage);
      args.callbacks?.onRoomMessage?.(roomMessage);
    }

    if (tool.roomAction?.type === "read_no_reply" && tool.roomAction.roomId && tool.roomAction.messageId) {
      const receiptUpdatedAt = args.createTimestamp();
      const receipt = args.createReadNoReplyReceipt(receiptUpdatedAt);
      const receiptUpdate = args.createMessageReceiptUpdate(tool.roomAction.roomId, tool.roomAction.messageId, receipt);
      receiptUpdates.push(receiptUpdate);
      args.callbacks?.onReceiptUpdate?.(receiptUpdate);

      if (tool.roomAction.roomId === args.roomId && tool.roomAction.messageId === args.userMessageId) {
        currentUserReceiptStatus = "read_no_reply";
        currentUserReceiptUpdatedAt = receiptUpdatedAt;
        currentUserReceipts = args.upsertReceipt(currentUserReceipts, receipt);
      }
    }
  }

  function finalizeOpenStreamAs(status: "completed" | "failed") {
    if (!activeRoomMessageStream) {
      return null;
    }

    const roomMessage = {
      ...activeRoomMessageStream.message,
      status,
      final: true,
    } satisfies RoomMessage;
    activeRoomMessageStream = null;
    upsertEmittedRoomMessageState(emittedMessages, timeline, roomMessage);
    args.callbacks?.onRoomMessage?.(roomMessage);
    return roomMessage;
  }

  function getRoomActions(): RoomToolActionUnion[] {
    return toolEvents.flatMap((tool) => (tool.roomAction ? [tool.roomAction] : []));
  }

  function getCompletedState(preferredToolEvents: ToolExecution[]) {
    finalizeOpenStreamAs("completed");
    return {
      draftSegments: finalizeLatestDraftSegment(draftSegments),
      timeline: [...timeline],
      toolEvents: toolEvents.length > 0 ? toolEvents : preferredToolEvents,
      emittedMessages: [...emittedMessages],
      receiptUpdates: [...receiptUpdates],
      currentUserReceipts: [...currentUserReceipts],
      currentUserReceiptStatus,
      currentUserReceiptUpdatedAt,
      roomActions: getRoomActions(),
    };
  }

  function getErrorPartial(): RoomTurnAccumulatorErrorPartial {
    finalizeOpenStreamAs("failed");
    return {
      agent: args.agent,
      roomId: args.roomId,
      userMessageId: args.userMessageId,
      userSender: args.userSender,
      userContent: args.userContent,
      userAttachments: args.userAttachments,
      ...(args.anchorMessageId ? { anchorMessageId: args.anchorMessageId } : {}),
      toolEvents: [...toolEvents],
      emittedMessages: [...emittedMessages],
      receiptUpdates: [...receiptUpdates],
      draftSegments: finalizeLatestDraftSegment(draftSegments),
      timeline: [...timeline],
      currentUserReceipts: [...currentUserReceipts],
      currentUserReceiptStatus,
      currentUserReceiptUpdatedAt,
      resolvedModel: args.resolvedModel,
      ...(args.continuationSnapshot ? { continuationSnapshot: args.continuationSnapshot } : {}),
    };
  }

  return {
    handleTextDelta,
    handlePreview,
    handleTool,
    getCompletedState,
    getErrorPartial,
  };
}
