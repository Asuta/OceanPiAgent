"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
import {
  ALLOWED_MESSAGE_IMAGE_MIME_TYPES,
  MAX_MESSAGE_IMAGE_ATTACHMENTS,
  MAX_MESSAGE_IMAGE_BYTES,
  formatMessageForTranscript,
} from "@/lib/chat/message-attachments";
import {
  DEFAULT_AGENT_ID,
  formatTimestamp,
  getHumanParticipants,
  getPrimaryRoomAgentId,
  getReceiptInlineNote,
  getToolStats,
  useWorkspace,
} from "@/components/workspace-provider";
import { RoomCronPanel } from "@/components/room-cron-panel";
import { DraftHistoryInline } from "@/components/workspace/draft-history-inline";
import { buildRoomThreadDraftEntries, buildRoomThreadToolEntries, type RoomThreadDraftEntry, type RoomThreadToolEntry } from "@/components/workspace/room-thread";
import { ToolHistoryInline } from "@/components/workspace/tool-history-inline";
import type { AgentRoomTurn, MessageImageAttachment, RoomAgentId, RoomMessage, RoomParticipant } from "@/lib/chat/types";

const DEFAULT_LOCAL_PARTICIPANT_ID = "local-operator";
const LOCAL_PARTICIPANT_NAME = "You";

function getTurnRoomId(turn: { userMessage: { roomId: string }; emittedMessages: Array<{ roomId: string }> }) {
  return turn.userMessage.roomId || turn.emittedMessages[0]?.roomId || "";
}

function getSortableTime(value: string) {
  const timestamp = Date.parse(value || "");
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function formatRawTurnLog(turn: AgentRoomTurn, roomTitle: string) {
  const sections = [
    `[turn] id=${turn.id}`,
    `status=${turn.status}`,
    `room=${roomTitle}`,
    `sender=${turn.userMessage.sender.name} (${turn.userMessage.sender.id})`,
    `createdAt=${turn.userMessage.createdAt}`,
    "",
    "[room-input]",
    formatMessageForTranscript(turn.userMessage.content, turn.userMessage.attachments) || "",
  ];

  if (turn.continuationSnapshot) {
    sections.push("", "[continuation-snapshot]", turn.continuationSnapshot);
  }

  if (turn.userMessage.receiptStatus === "read_no_reply") {
    sections.push("", "[receipts]", getReceiptInlineNote(turn.userMessage.receipts));
  }

  sections.push("", "[assistant-output]", turn.assistantContent || "The model returned no text.");

  if (turn.emittedMessages.length > 0) {
    sections.push("", "[room-emissions]");
    for (const message of turn.emittedMessages) {
      sections.push(
        `- id=${message.id} kind=${message.kind} status=${message.status} final=${message.final ? "true" : "false"} sender=${message.sender.name}`,
        formatMessageForTranscript(message.content, message.attachments),
      );
    }
  }

  if (turn.tools.length > 0) {
    sections.push("", "[tools]");
    for (const tool of turn.tools) {
      sections.push(
        `- seq=${tool.sequence} name=${tool.toolName} display=${tool.displayName} status=${tool.status} durationMs=${tool.durationMs}`,
        "  [input]",
        tool.inputText || "",
        "  [output]",
        tool.outputText || "",
      );
    }
  }

  if (turn.meta?.emptyCompletion) {
    const diagnostic = turn.meta.emptyCompletion;
    sections.push(
      "",
      "[empty-completion-diagnostic]",
      `createdAt=${diagnostic.createdAt}`,
      `apiFormat=${diagnostic.apiFormat}`,
      `provider=${diagnostic.providerLabel} (${diagnostic.providerKey})`,
      `requestedModel=${diagnostic.requestedModel || "<default>"}`,
      `resolvedModel=${diagnostic.resolvedModel || "<unknown>"}`,
      `baseUrl=${diagnostic.baseUrl}`,
      `textDeltaLength=${diagnostic.textDeltaLength}`,
      `finalTextLength=${diagnostic.finalTextLength}`,
      `toolCallCount=${diagnostic.toolCallCount}`,
      `toolEventCount=${diagnostic.toolEventCount}`,
    );

    if (typeof diagnostic.finishReason !== "undefined") {
      sections.push(`finishReason=${diagnostic.finishReason ?? "null"}`);
    }

    if (diagnostic.payloadMode) {
      sections.push(`payloadMode=${diagnostic.payloadMode}`);
    }

    if (diagnostic.responseId) {
      sections.push(`responseId=${diagnostic.responseId}`);
    }

    if (diagnostic.assistantContentShape) {
      sections.push(`assistantContentShape=${diagnostic.assistantContentShape}`);
    }

    if (diagnostic.outputItemTypes && diagnostic.outputItemTypes.length > 0) {
      sections.push(`outputItemTypes=${diagnostic.outputItemTypes.join(", ")}`);
    }

    if (typeof diagnostic.chunkCount === "number") {
      sections.push(`chunkCount=${diagnostic.chunkCount}`);
    }

    if (typeof diagnostic.sawDoneEvent === "boolean") {
      sections.push(`sawDoneEvent=${diagnostic.sawDoneEvent ? "true" : "false"}`);
    }

    if (diagnostic.chunkPreviews && diagnostic.chunkPreviews.length > 0) {
      sections.push("[chunk-previews]", ...diagnostic.chunkPreviews);
    }
  }

  if (turn.meta?.recovery?.attempts.length) {
    sections.push("", "[recovery-attempts]");
    for (const attempt of turn.meta.recovery.attempts) {
      sections.push(
        `- attempt=${attempt.attempt} strategy=${attempt.strategy} trigger=${attempt.trigger} delayMs=${attempt.delayMs} toolEventCount=${attempt.toolEventCount}`,
      );

      if (typeof attempt.finishReason !== "undefined") {
        sections.push(`  finishReason=${attempt.finishReason ?? "null"}`);
      }

      if (typeof attempt.chunkCount === "number") {
        sections.push(`  chunkCount=${attempt.chunkCount}`);
      }

      if (typeof attempt.sawDoneEvent === "boolean") {
        sections.push(`  sawDoneEvent=${attempt.sawDoneEvent ? "true" : "false"}`);
      }

      if (attempt.chunkPreviews?.length) {
        sections.push("  [chunk-previews]", ...attempt.chunkPreviews.map((preview) => `  ${preview}`));
      }
    }
  }

  if (turn.error) {
    sections.push("", "[error]", turn.error);
  }

  return sections.join("\n");
}

const ROOM_KIND_LABELS: Record<RoomMessage["kind"], string> = {
  user_input: "用户",
  answer: "回复",
  progress: "进度",
  warning: "提醒",
  error: "异常",
  clarification: "澄清",
  system: "系统",
};

const ROOM_STATUS_LABELS: Record<RoomMessage["status"], string> = {
  pending: "等待中",
  streaming: "生成中",
  completed: "已完成",
  failed: "失败",
};

const STARTER_PROMPTS = [
  "请创建一个新的房间，把所有人都拉进来，让大家讨论一下：是周星驰更厉害，还是周润发更厉害？",
  "请用更清晰的方式总结一下当前工作流。",
  "如果我要开始一个新任务，你建议我怎么描述？",
];

function getMessageKicker(message: RoomMessage) {
  if (message.role === "user") {
    return "参与者消息";
  }

  if (message.role === "system") {
    return "系统同步";
  }

  return message.kind === "answer" ? "房间回复" : ROOM_KIND_LABELS[message.kind];
}

function getSenderMonogram(name: string) {
  return name.trim().charAt(0).toUpperCase() || "?";
}

function getMessageCardClass(message: RoomMessage) {
  const parts = ["thread-message-card"];
  if (message.role === "user") {
    parts.push("user");
  }
  if (message.role === "assistant") {
    parts.push("assistant");
  }
  if (message.role === "system") {
    parts.push("system");
  }
  if (message.kind !== "answer" && message.kind !== "user_input") {
    parts.push(`kind-${message.kind}`);
  }
  if (message.role === "assistant" && message.status !== "completed") {
    parts.push("is-streaming");
  }
  return parts.join(" ");
}

export function RoomDetailPage({ roomId }: { roomId: string }) {
  const router = useRouter();
  const {
    agents,
    rooms,
    activeRooms,
    agentStates,
    draftsByRoomId,
    getRoomById,
    hydrated,
    selectedConsoleAgentId,
    selectedSenderByRoomId,
    setActiveRoomId,
    setDraft,
    setSelectedConsoleAgentId,
    setSelectedSender,
    sendMessage,
    clearRoom,
    archiveRoom,
    deleteRoom,
    renameRoom,
    addHumanParticipant,
    addAgentParticipant,
    removeParticipant,
    toggleAgentParticipant,
    moveAgentParticipant,
    isAgentRunning,
    isRoomRunning,
    clearAgentConsole,
    resetAgentContext,
    getAgentDefinition,
  } = useWorkspace();

  const [inspectorTab, setInspectorTab] = useState<"console" | "room">("console");
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [consoleScope, setConsoleScope] = useState<"room" | "all" | "timeline">("room");
  const [consoleViewMode, setConsoleViewMode] = useState<"formatted" | "raw">("formatted");
  const [newParticipantName, setNewParticipantName] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<MessageImageAttachment[]>([]);
  const [uploadError, setUploadError] = useState("");
  const [isUploadingImages, setIsUploadingImages] = useState(false);
  const [titleDraftByRoomId, setTitleDraftByRoomId] = useState<Record<string, string>>({});
  const [showStarterPrompts, setShowStarterPrompts] = useState(false);
  const threadListRef = useRef<HTMLDivElement | null>(null);
  const workbenchBodyRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stickThreadToBottomRef = useRef(true);
  const lastThreadRoomIdRef = useRef<string | null>(null);

  const room = getRoomById(roomId);

  useEffect(() => {
    setPendingAttachments([]);
    setUploadError("");
    setIsUploadingImages(false);
    setShowStarterPrompts(false);
    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
  }, [room?.id]);

  const scrollThreadListToBottom = useCallback(() => {
    const threadList = threadListRef.current;
    if (!threadList) {
      return;
    }

    threadList.scrollTop = threadList.scrollHeight;
    stickThreadToBottomRef.current = true;
  }, []);

  const scrollWorkbenchToBottom = useCallback(() => {
    const workbenchBody = workbenchBodyRef.current;
    if (!workbenchBody) {
      return;
    }

    workbenchBody.scrollTop = workbenchBody.scrollHeight;
  }, []);

  useEffect(() => {
    if (room) {
      setActiveRoomId(room.id);
    }
  }, [room, setActiveRoomId]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    if (!room) {
      const fallback = activeRooms[0];
      router.replace(fallback ? `/rooms/${fallback.id}` : "/rooms");
    }
  }, [activeRooms, hydrated, room, router]);

  useEffect(() => {
    const threadList = threadListRef.current;
    if (!threadList) {
      return;
    }

    const updateStickState = () => {
      const distanceFromBottom = threadList.scrollHeight - threadList.scrollTop - threadList.clientHeight;
      stickThreadToBottomRef.current = distanceFromBottom <= 32;
    };

    updateStickState();
    threadList.addEventListener("scroll", updateStickState, { passive: true });
    return () => threadList.removeEventListener("scroll", updateStickState);
  }, [room?.id]);

  const latestMessage = room?.roomMessages.at(-1) ?? null;
  const roomThreadToolEntries = useMemo<Map<string, RoomThreadToolEntry[]>>(
    () =>
      room
        ? buildRoomThreadToolEntries({
            roomId: room.id,
            roomMessages: room.roomMessages,
            agentStates,
          })
        : new Map<string, RoomThreadToolEntry[]>(),
    [agentStates, room],
  );
  const roomThreadDraftEntries = useMemo<Map<string, RoomThreadDraftEntry[]>>(
    () =>
      room
        ? buildRoomThreadDraftEntries({
            roomId: room.id,
            roomMessages: room.roomMessages,
            agentStates,
          })
        : new Map<string, RoomThreadDraftEntry[]>(),
    [agentStates, room],
  );
  const visibleInlineTools = useMemo(() => Array.from(roomThreadToolEntries.values()).flat(), [roomThreadToolEntries]);
  const visibleInlineDrafts = useMemo(() => Array.from(roomThreadDraftEntries.values()).flat(), [roomThreadDraftEntries]);
  const latestInlineTool = visibleInlineTools.at(-1) ?? null;
  const latestInlineDraft = visibleInlineDrafts.at(-1) ?? null;
  const threadScrollKey = room
    ? `${room.roomMessages.length}:${latestMessage?.id ?? ""}:${latestMessage?.status ?? ""}:${latestMessage?.content.length ?? 0}:${latestMessage?.attachments.length ?? 0}:${visibleInlineTools.length}:${latestInlineTool?.turn.id ?? ""}:${latestInlineTool?.tool.id ?? ""}:${latestInlineTool?.event.sequence ?? 0}:${visibleInlineDrafts.length}:${latestInlineDraft?.turn.id ?? ""}:${latestInlineDraft?.turn.status ?? ""}:${latestInlineDraft?.turn.assistantContent.length ?? 0}`
    : "";

  useLayoutEffect(() => {
    if (!room) {
      lastThreadRoomIdRef.current = null;
      return;
    }

    const roomChanged = lastThreadRoomIdRef.current !== room.id;
    const shouldStick = roomChanged || stickThreadToBottomRef.current;
    const frameId = window.requestAnimationFrame(() => {
      if (!shouldStick) {
        return;
      }

      scrollThreadListToBottom();
    });
    const settleTimer = roomChanged
      ? window.setTimeout(() => {
          scrollThreadListToBottom();
        }, 80)
      : null;

    lastThreadRoomIdRef.current = room.id;

    return () => {
      window.cancelAnimationFrame(frameId);
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
      }
    };
  }, [room, scrollThreadListToBottom, threadScrollKey]);

  useLayoutEffect(() => {
    if (!workbenchOpen || inspectorTab !== "console") {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      scrollWorkbenchToBottom();
    });
    const settleTimer = window.setTimeout(() => {
      scrollWorkbenchToBottom();
    }, 80);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(settleTimer);
    };
  }, [inspectorTab, room?.id, scrollWorkbenchToBottom, workbenchOpen]);

  const roomDraft = room ? draftsByRoomId[room.id] ?? "" : "";
  const isRunning = room ? isRoomRunning(room.id) : false;
  const humanParticipants = useMemo(() => (room ? getHumanParticipants(room) : []), [room]);
  const availableSenders = useMemo<RoomParticipant[]>(() => {
    if (!room) {
      return [];
    }

    const hasLocalParticipant = humanParticipants.some((participant) => participant.id === DEFAULT_LOCAL_PARTICIPANT_ID);
    if (hasLocalParticipant) {
      return humanParticipants;
    }

    return [
      {
        id: DEFAULT_LOCAL_PARTICIPANT_ID,
        name: LOCAL_PARTICIPANT_NAME,
        senderRole: "participant",
        runtimeKind: "human",
        enabled: true,
        order: 0,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
      },
      ...humanParticipants,
    ];
  }, [humanParticipants, room]);
  const selectedSenderId = room ? selectedSenderByRoomId[room.id] : undefined;
  const selectedSender = availableSenders.find((participant) => participant.id === selectedSenderId) ?? availableSenders[0] ?? null;
  const primaryAgentId = room ? getPrimaryRoomAgentId(room) : DEFAULT_AGENT_ID;
  const consoleAgentId = (selectedConsoleAgentId ?? primaryAgentId) as RoomAgentId;
  const consoleAgentState = agentStates[consoleAgentId];
  const titleDraft = room ? titleDraftByRoomId[room.id] ?? room.title : "";
  const activeParticipant = room?.participants.find((participant) => participant.id === room.scheduler.activeParticipantId) ?? null;
  const ownerParticipant = room?.participants.find((participant) => participant.id === room.ownerParticipantId) ?? null;
  const localParticipantMissing = room ? !room.participants.some((participant) => participant.id === DEFAULT_LOCAL_PARTICIPANT_ID) : false;
  const canSend = Boolean((roomDraft.trim() || pendingAttachments.length > 0) && selectedSender && !isUploadingImages);
  const currentRoomId = room?.id ?? roomId;
  const currentRoomTitle = room?.title ?? "Unknown room";
  const roomTitleById = useMemo(() => new Map(rooms.map((entry) => [entry.id, entry.title])), [rooms]);
  const roomTurns = useMemo(
    () =>
      room
        ? (consoleAgentState?.agentTurns ?? []).filter(
            (turn) => turn.userMessage.roomId === room.id || turn.emittedMessages.some((message) => message.roomId === room.id),
          )
        : [],
    [consoleAgentState?.agentTurns, room],
  );
  const roomTurnStats = useMemo(() => {
    return roomTurns.reduce(
      (stats, turn) => {
        stats.turns += 1;
        stats.tools += turn.tools.length;
        stats.emissions += turn.emittedMessages.length;
        return stats;
      },
      { turns: 0, tools: 0, emissions: 0 },
    );
  }, [roomTurns]);
  const visibleConsoleTurns = useMemo(() => {
    const turns = consoleScope === "room" ? roomTurns : (consoleAgentState?.agentTurns ?? []);
    return [...turns].sort((left, right) => getSortableTime(left.userMessage.createdAt) - getSortableTime(right.userMessage.createdAt));
  }, [consoleAgentState?.agentTurns, consoleScope, roomTurns]);

  useLayoutEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [room?.id, roomDraft]);
  const consoleTurnGroups = useMemo(() => {
    if (!room) {
      return [] as Array<{ roomId: string; roomTitle: string; turns: typeof visibleConsoleTurns }>;
    }

    if (consoleScope === "timeline") {
      return [
        {
          roomId: "timeline",
          roomTitle: "执行顺序",
          turns: visibleConsoleTurns,
        },
      ];
    }

    const groups = new Map<string, { roomId: string; roomTitle: string; turns: typeof visibleConsoleTurns }>();
    for (const turn of visibleConsoleTurns) {
      const turnRoomId = getTurnRoomId(turn) || room.id;
      const existing = groups.get(turnRoomId);
      if (existing) {
        existing.turns.push(turn);
        continue;
      }

      groups.set(turnRoomId, {
        roomId: turnRoomId,
        roomTitle: roomTitleById.get(turnRoomId) ?? (turnRoomId === room.id ? room.title : "Unknown room"),
        turns: [turn],
      });
    }

    return Array.from(groups.values()).sort((left, right) => {
      const leftTime = getSortableTime(left.turns[left.turns.length - 1]?.userMessage.createdAt ?? "");
      const rightTime = getSortableTime(right.turns[right.turns.length - 1]?.userMessage.createdAt ?? "");
      return rightTime - leftTime;
    });
  }, [consoleScope, room, roomTitleById, visibleConsoleTurns]);

  const removePendingAttachment = useCallback((attachmentId: string) => {
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    setUploadError("");
  }, []);

  const resetPendingAttachments = useCallback(() => {
    setPendingAttachments([]);
    setUploadError("");
    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
  }, []);

  const uploadImageFiles = useCallback(
    async (selectedFiles: File[]) => {
      if (selectedFiles.length === 0) {
        return;
      }

      const remainingSlots = Math.max(0, MAX_MESSAGE_IMAGE_ATTACHMENTS - pendingAttachments.length);
      if (remainingSlots === 0) {
        setUploadError(`最多只能上传 ${MAX_MESSAGE_IMAGE_ATTACHMENTS} 张图片。`);
        return;
      }

      const imageFiles = selectedFiles.filter((file) => ALLOWED_MESSAGE_IMAGE_MIME_TYPES.includes(file.type as (typeof ALLOWED_MESSAGE_IMAGE_MIME_TYPES)[number]));
      if (imageFiles.length === 0) {
        setUploadError("只支持 PNG / JPEG / WebP 图片。");
        return;
      }

      const filesToUpload = imageFiles.slice(0, remainingSlots);
      setIsUploadingImages(true);
      setUploadError(
        filesToUpload.length < imageFiles.length || imageFiles.length < selectedFiles.length
          ? `最多只能上传 ${MAX_MESSAGE_IMAGE_ATTACHMENTS} 张图片，已忽略不支持或超出的文件。`
          : "",
      );

      try {
        const uploadedAttachments = await Promise.all(
          filesToUpload.map(async (file) => {
            const formData = new FormData();
            formData.append("file", file);
            const response = await fetch("/api/uploads/image", {
              method: "POST",
              body: formData,
            });
            const payload = (await response.json().catch(() => null)) as { attachment?: MessageImageAttachment; error?: string } | null;
            if (!response.ok || !payload?.attachment) {
              throw new Error(payload?.error || `图片 ${file.name} 上传失败。`);
            }
            return payload.attachment;
          }),
        );

        setPendingAttachments((current) => [...current, ...uploadedAttachments]);
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : "图片上传失败。");
      } finally {
        setIsUploadingImages(false);
      }
    },
    [pendingAttachments.length],
  );

  const handleImageSelection = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(event.target.files ?? []);
      try {
        await uploadImageFiles(selectedFiles);
      } finally {
        event.target.value = "";
      }
    },
    [uploadImageFiles],
  );

  const handleComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items ?? []);
      const pastedImageFiles = items
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));

      if (pastedImageFiles.length === 0) {
        return;
      }

      void uploadImageFiles(pastedImageFiles);
    },
    [uploadImageFiles],
  );

  const submitMessage = useCallback(async () => {
    if (!room || !selectedSender || !canSend) {
      return;
    }

    const contentToSend = roomDraft;
    const attachmentsToSend = [...pendingAttachments];
    resetPendingAttachments();

    try {
      await sendMessage({
        roomId: room.id,
        content: contentToSend,
        attachments: attachmentsToSend,
        senderId: selectedSender.id,
      });
    } catch (error) {
      setPendingAttachments(attachmentsToSend);
      setDraft(room.id, contentToSend);
      setUploadError(error instanceof Error ? error.message : "发送消息失败。");
    }
  }, [canSend, pendingAttachments, resetPendingAttachments, room, roomDraft, selectedSender, sendMessage, setDraft]);

  function renderTurnCard(turn: (typeof visibleConsoleTurns)[number], index: number, total: number, groupRoomId: string) {
    const toolStats = getToolStats(turn.tools);
    const turnRoomId = getTurnRoomId(turn) || groupRoomId;
    const turnRoomTitle = roomTitleById.get(turnRoomId) ?? (turnRoomId === currentRoomId ? currentRoomTitle : "Unknown room");

    return (
      <details key={turn.id} className="trace-card" open={index === total - 1}>
        <summary>
          <div>
            <p className="section-label">Turn {index + 1}</p>
            <strong>{turn.userMessage.sender.name}</strong>
            <span>{formatTimestamp(turn.userMessage.createdAt)}</span>
          </div>
          <div className="meta-chip-row compact align-end">
            {consoleScope !== "room" ? <span className="meta-chip subtle">{turnRoomTitle}</span> : null}
            <span className="meta-chip">{turn.status}</span>
            <span className="meta-chip subtle">{toolStats.total} 个工具</span>
            <span className="meta-chip subtle">{turn.emittedMessages.length} 条可见输出</span>
          </div>
        </summary>
        <div className="trace-body">
          {consoleViewMode === "raw" ? (
            <section className="trace-block raw-log-block">
              <span>Raw log</span>
              <pre>{formatRawTurnLog(turn, turnRoomTitle)}</pre>
            </section>
          ) : (
            <>
              <section className="trace-block">
                <span>房间输入</span>
                {turn.userMessage.content ? <p>{turn.userMessage.content}</p> : null}
                {turn.userMessage.attachments.length > 0 ? (
                  <div className="message-image-grid compact">
                    {turn.userMessage.attachments.map((attachment) => (
                      <a key={attachment.id} className="message-image-link" href={attachment.url} target="_blank" rel="noreferrer">
                        <Image
                          src={attachment.url}
                          alt={attachment.filename}
                          className="message-image-preview"
                          width={240}
                          height={180}
                          unoptimized
                        />
                        <span>{attachment.filename}</span>
                      </a>
                    ))}
                  </div>
                ) : null}
                {turn.userMessage.receiptStatus === "read_no_reply" ? <small>{getReceiptInlineNote(turn.userMessage.receipts)}</small> : null}
              </section>

              {turn.continuationSnapshot ? (
                <section className="trace-block">
                  <span>续跑上下文</span>
                  <pre>{turn.continuationSnapshot}</pre>
                </section>
              ) : null}

              <section className="trace-block">
                <span>内部输出</span>
                <p>{turn.assistantContent || "这一轮没有留下可见的内部文本。"}</p>
              </section>

              {turn.emittedMessages.length > 0 ? (
                <section className="trace-block">
                  <span>投递回房间的内容</span>
                  <div className="stacked-list compact-gap">
                    {turn.emittedMessages.map((message) => (
                      <div key={message.id} className="micro-card">
                        <strong>{ROOM_KIND_LABELS[message.kind]}</strong>
                        <p>{message.content}</p>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {turn.tools.length > 0 ? (
                <section className="trace-block">
                  <span>工具步骤</span>
                  <div className="stacked-list compact-gap">
                    {turn.tools.map((tool) => (
                      <details key={tool.id} className="micro-card tool-step">
                        <summary>
                          <div>
                            <strong>{tool.displayName}</strong>
                            <span>{tool.durationMs} ms</span>
                          </div>
                          <span>{tool.status}</span>
                        </summary>
                        <div className="code-pair-grid">
                          <pre>{tool.inputText}</pre>
                          <pre>{tool.outputText}</pre>
                        </div>
                      </details>
                    ))}
                  </div>
                </section>
              ) : null}

              {turn.error ? <p className="error-text">{turn.error}</p> : null}
            </>
          )}
        </div>
      </details>
    );
  }

  if (!room) {
    return (
      <div className="page-stack">
        <section className="surface-panel empty-panel large">正在恢复房间内容...</section>
      </div>
    );
  }

  return (
    <div className="page-stack room-detail-page chat-centric-page">
      <div className={`room-detail-layout${workbenchOpen ? " sidepanel-open" : ""}`}>
        <section className="surface-panel thread-panel room-chat-shell page-enter">
          <div className="room-chat-topbar">
            <div className="room-chat-titleblock">
              <div className="room-chat-titleline">
                <h1>{room.title}</h1>
                <span className={isRunning ? "thread-status running" : "thread-status idle"}>{isRunning ? "处理中" : "空闲"}</span>
                <span className="meta-chip subtle">{getAgentDefinition(primaryAgentId).label}</span>
                <span className="meta-chip subtle">{room.roomMessages.length} 条消息</span>
              </div>
              <p className="thread-panel-copy">
                {isRunning ? `${activeParticipant?.name || getAgentDefinition(primaryAgentId).label} 正在继续处理这条会话。` : "当前房间已准备就绪，可以直接继续对话。"}
              </p>
            </div>

            <div className="room-chat-toolbar">
              <button
                type="button"
                className={workbenchOpen && inspectorTab === "console" ? "tab-button active" : "tab-button"}
                onClick={() => {
                  setInspectorTab("console");
                  setWorkbenchOpen(true);
                }}
              >
                执行详情
              </button>
              <button
                type="button"
                className={workbenchOpen && inspectorTab === "room" ? "tab-button active" : "tab-button"}
                onClick={() => {
                  setInspectorTab("room");
                  setWorkbenchOpen(true);
                }}
              >
                房间设置
              </button>
              <Link href="/settings" className="secondary-button">
                打开设置
              </Link>
              <button type="button" className="ghost-button" onClick={() => clearRoom(room.id)} disabled={isRunning}>
                清空房间
              </button>
            </div>
          </div>

          {isRunning ? (
            <div className="thread-live-banner" role="status" aria-live="polite">
              <div className="thread-live-copy">
                <strong>{activeParticipant?.name || getAgentDefinition(primaryAgentId).label} 正在继续处理这条会话</strong>
                <p>如果你现在发送新消息，会中断当前轮询并接管为新的上下文。</p>
              </div>
              <span className="thread-live-badge">live</span>
            </div>
          ) : null}

          <div ref={threadListRef} className="thread-list">
            {room.roomMessages.length === 0 ? (
              <div className="empty-panel thread-empty rich-empty-state">
                <div className="empty-orbit" aria-hidden="true">
                  <span className="empty-orbit-ring large" />
                  <span className="empty-orbit-ring small" />
                  <span className="empty-orbit-core" />
                </div>
                <div className="empty-copy-stack">
                  <p className="section-label">准备开始</p>
                  <h3>这个房间还没有第一条消息</h3>
                  <p>先发一条清晰的目标描述，房间会在内部完成调度，再把适合展示给你的内容投递回来。</p>
                </div>
                <div className="starter-prompt-grid">
                  {STARTER_PROMPTS.map((prompt) => (
                    <button key={prompt} type="button" className="starter-prompt" onClick={() => setDraft(room.id, prompt)}>
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              room.roomMessages.map((message, index) => {
                const shouldShowState = message.role === "assistant" && (message.kind !== "answer" || message.status !== "completed");
                const isLatestMessage = index === room.roomMessages.length - 1;
                const inlineToolEntries = roomThreadToolEntries.get(message.id) ?? [];
                const inlineDraftEntries = roomThreadDraftEntries.get(message.id) ?? [];
                const inlineArtifacts = [
                  ...inlineToolEntries.map((entry) => ({ kind: "tool" as const, sequence: entry.event.sequence, id: entry.id, entry })),
                  ...inlineDraftEntries.map((entry) => ({ kind: "draft" as const, sequence: entry.event.sequence, id: entry.id, entry })),
                ].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
                return (
                  <Fragment key={message.id}>
                    <article
                      className={`${getMessageCardClass(message)}${isLatestMessage ? " is-latest" : ""}`}
                      style={isLatestMessage ? undefined : { animationDelay: `${Math.min(index * 34, 180)}ms` }}
                    >
                      <div className={`message-avatar ${message.role}`} aria-hidden="true">
                        {getSenderMonogram(message.sender.name)}
                      </div>
                      <div className="thread-message-content">
                        <div className="thread-message-topline">
                          <div className="thread-message-heading">
                            <span className="thread-message-kicker">{getMessageKicker(message)}</span>
                            <strong>{message.sender.name}</strong>
                          </div>
                          <span>{formatTimestamp(message.createdAt)}</span>
                        </div>

                        {(shouldShowState || message.receipts.length > 0) && (
                          <div className="message-state-row">
                            {shouldShowState ? <span className="meta-chip subtle">{ROOM_KIND_LABELS[message.kind]}</span> : null}
                            {shouldShowState ? <span className="meta-chip subtle">{ROOM_STATUS_LABELS[message.status]}</span> : null}
                            {message.final === false ? <span className="meta-chip subtle">过程消息</span> : null}
                            {message.receipts.length > 0 ? <span className="meta-chip subtle">已读不回</span> : null}
                          </div>
                        )}

                        {message.content ? <div className="thread-message-body">{message.content}</div> : null}

                        {message.attachments.length > 0 ? (
                          <div className="message-image-grid">
                            {message.attachments.map((attachment) => (
                              <a key={attachment.id} className="message-image-link" href={attachment.url} target="_blank" rel="noreferrer">
                                <Image
                                  src={attachment.url}
                                  alt={attachment.filename}
                                  className="message-image-preview"
                                  width={240}
                                  height={180}
                                  unoptimized
                                />
                                <span>{attachment.filename}</span>
                              </a>
                            ))}
                          </div>
                        ) : null}

                        {message.receipts.length > 0 ? (
                          <div className="message-receipt-note">
                            {message.receipts.map((receipt) => `✓ ${receipt.participantName}`).join("  ")}
                          </div>
                        ) : null}
                      </div>
                    </article>

                    {inlineArtifacts.length > 0 ? (
                      <div className="thread-turn-inline-stack draft-stack">
                        {inlineArtifacts.map((artifact) => (
                          artifact.kind === "tool" ? (
                            <ToolHistoryInline
                              key={artifact.id}
                              entry={artifact.entry}
                              defaultOpen={false}
                            />
                          ) : (
                            <DraftHistoryInline
                              key={artifact.id}
                              entry={artifact.entry}
                              defaultOpen={artifact.entry.segment.status === "streaming"}
                            />
                          )
                        ))}
                      </div>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </div>

          <form
            className="composer-card compact-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submitMessage();
            }}
          >
            <div className="composer-toolbar">
              <div className="composer-tool-group">
                <label className="field-block inline-field compact-width composer-inline-field" htmlFor="room-sender-select">
                  <span className="composer-inline-label">发送身份</span>
                  <select
                    id="room-sender-select"
                    className="text-input composer-select"
                    value={selectedSender?.id ?? ""}
                    onChange={(event) => setSelectedSender(room.id, event.target.value)}
                    disabled={availableSenders.length === 0 || isRunning}
                  >
                    {availableSenders.map((participant) => (
                      <option key={participant.id} value={participant.id}>
                        {participant.name}
                      </option>
                    ))}
                  </select>
                </label>

                <input
                  ref={imageInputRef}
                  type="file"
                  accept={ALLOWED_MESSAGE_IMAGE_MIME_TYPES.join(",")}
                  multiple
                  hidden
                  onChange={handleImageSelection}
                  disabled={isRunning || isUploadingImages || pendingAttachments.length >= MAX_MESSAGE_IMAGE_ATTACHMENTS}
                />
                <button
                  type="button"
                  className="secondary-button composer-toolbar-button"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={isRunning || isUploadingImages || pendingAttachments.length >= MAX_MESSAGE_IMAGE_ATTACHMENTS}
                  title={`最多 ${MAX_MESSAGE_IMAGE_ATTACHMENTS} 张，支持 PNG / JPEG / WebP，单张不超过 ${Math.floor(MAX_MESSAGE_IMAGE_BYTES / (1024 * 1024))} MB，也可直接粘贴截图。`}
                >
                  {isUploadingImages ? "上传中..." : pendingAttachments.length > 0 ? `图片 ${pendingAttachments.length}` : "图片"}
                </button>

                {room.roomMessages.length > 0 ? (
                  <button
                    type="button"
                    className="ghost-button composer-toolbar-button"
                    onClick={() => setShowStarterPrompts((current) => !current)}
                    aria-expanded={showStarterPrompts}
                  >
                    {showStarterPrompts ? "收起灵感" : "灵感"}
                  </button>
                ) : null}
              </div>

              <div className="composer-action-cluster">
                <span className={`thread-status ${isRunning ? "running" : "idle"}`}>
                  {isUploadingImages ? "图片上传中" : isRunning ? "Agent 处理中" : canSend ? "可发送" : "待输入"}
                </span>
                <button type="submit" className="primary-button composer-send-button" disabled={!canSend}>
                  发送
                </button>
              </div>
            </div>

            <div className="composer-input-shell">
              <textarea
                ref={composerTextareaRef}
                id="room-draft"
                name="draft"
                className="text-area composer-textarea"
                value={roomDraft}
                onChange={(event) => setDraft(room.id, event.target.value)}
                onPaste={handleComposerPaste}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submitMessage();
                  }
                }}
                placeholder="输入新的房间消息，Enter 发送，Shift + Enter 换行，支持粘贴截图..."
              />
            </div>

            {pendingAttachments.length > 0 ? (
              <div className="composer-attachment-list compact">
                {pendingAttachments.map((attachment) => (
                  <div key={attachment.id} className="composer-attachment-chip">
                    <Image
                      src={attachment.url}
                      alt={attachment.filename}
                      className="composer-attachment-thumb"
                      width={56}
                      height={56}
                      unoptimized
                    />
                    <span>{attachment.filename}</span>
                    <button type="button" className="icon-button" onClick={() => removePendingAttachment(attachment.id)} aria-label={`移除 ${attachment.filename}`}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {room.roomMessages.length > 0 && showStarterPrompts ? (
              <div className="quick-reply-row composer-quick-reply-row">
                {STARTER_PROMPTS.map((prompt) => (
                  <button key={prompt} type="button" className="starter-prompt compact" onClick={() => setDraft(room.id, prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            ) : null}

            {room.error ? <p className="error-text">{room.error}</p> : null}
            {uploadError ? <p className="error-text">{uploadError}</p> : null}

            <div className="composer-footnote-row">
              <span className="composer-note">
                {isUploadingImages
                  ? "图片上传完成后即可发送。"
                  : isRunning
                  ? "发送新消息会接管当前轮询。"
                  : localParticipantMissing
                    ? "你当前不在成员列表里；发送消息会自动重新加入。"
                    : "房间状态会同步到服务端，本地仍保留缓存副本。"}
              </span>
              <span className="composer-note">最多 {MAX_MESSAGE_IMAGE_ATTACHMENTS} 张图片，可直接粘贴截图。</span>
            </div>
          </form>
        </section>

        {workbenchOpen ? (
          <aside className="surface-panel section-panel room-side-panel page-enter page-enter-delay-1">
            <div className="room-side-panel-header">
              <div>
                <p className="section-label">Workbench</p>
                <h2>{inspectorTab === "console" ? "执行详情" : "房间设置"}</h2>
                <p className="muted-copy">
                  {inspectorTab === "console"
                    ? `当前已记录 ${roomTurnStats.turns} 轮轨迹、${roomTurnStats.tools} 次工具调用。`
                    : `当前房间有 ${room.participants.length} 位参与者，owner 为 ${ownerParticipant?.name ?? "none"}。`}
                </p>
              </div>
              <div className="inspector-tabs">
                <button type="button" className={inspectorTab === "console" ? "tab-button active" : "tab-button"} onClick={() => setInspectorTab("console")}>
                  执行详情
                </button>
                <button type="button" className={inspectorTab === "room" ? "tab-button active" : "tab-button"} onClick={() => setInspectorTab("room")}>
                  房间设置
                </button>
                <button type="button" className="ghost-button" onClick={() => setWorkbenchOpen(false)}>
                  收起
                </button>
              </div>
            </div>

            <div ref={workbenchBodyRef} className="room-side-panel-body inspector-stack">
              {inspectorTab === "console" ? (
                <div className="inspector-stack">
                  <section className="subtle-panel">
                    <div className="section-heading-row compact-align">
                      <div>
                        <p className="section-label">执行视角</p>
                        <h3>
                          {consoleScope === "all"
                            ? "按 Agent 查看全部房间轨迹"
                            : consoleScope === "timeline"
                              ? "按执行顺序查看全部房间轨迹"
                              : "按 Agent 查看当前房间轨迹"}
                        </h3>
                      </div>
                      <select
                        className="text-input compact-select"
                        value={consoleAgentId}
                        onChange={(event) => setSelectedConsoleAgentId(event.target.value as RoomAgentId)}
                      >
                        {agents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="segmented-row top-gap">
                      <button
                        type="button"
                        className={consoleScope === "room" ? "tab-button active" : "tab-button"}
                        onClick={() => setConsoleScope("room")}
                      >
                        当前房间
                      </button>
                      <button
                        type="button"
                        className={consoleScope === "all" ? "tab-button active" : "tab-button"}
                        onClick={() => setConsoleScope("all")}
                      >
                        所有房间
                      </button>
                      <button
                        type="button"
                        className={consoleScope === "timeline" ? "tab-button active" : "tab-button"}
                        onClick={() => setConsoleScope("timeline")}
                      >
                        执行顺序
                      </button>
                    </div>

                    <div className="segmented-row top-gap">
                      <button
                        type="button"
                        className={consoleViewMode === "formatted" ? "tab-button active" : "tab-button"}
                        onClick={() => setConsoleViewMode("formatted")}
                      >
                        格式化视图
                      </button>
                      <button
                        type="button"
                        className={consoleViewMode === "raw" ? "tab-button active" : "tab-button"}
                        onClick={() => setConsoleViewMode("raw")}
                      >
                        Raw log
                      </button>
                    </div>

                    <div className="card-actions compact-right top-gap">
                      <button type="button" className="ghost-button" onClick={() => clearAgentConsole(consoleAgentId)} disabled={isAgentRunning(consoleAgentId)}>
                        清空显示轨迹
                      </button>
                      <button type="button" className="secondary-button" onClick={() => void resetAgentContext(consoleAgentId)} disabled={isAgentRunning(consoleAgentId)}>
                        重置 Agent 上下文
                      </button>
                    </div>
                    <p className="composer-note">
                      清空显示轨迹只移除当前面板记录；重置 Agent 上下文会清空该 Agent 在所有房间共享的服务端记忆。
                    </p>
                  </section>

                  {visibleConsoleTurns.length === 0 ? (
                    <div className="empty-panel">
                      {consoleScope === "room"
                        ? "当前房间还没有与这个 Agent 相关的执行记录。"
                        : "这个 Agent 还没有任何房间执行记录。"}
                    </div>
                  ) : (
                    <div className="stacked-list compact-gap">
                      {consoleTurnGroups.map((group) => (
                        <section key={group.roomId} className="subtle-panel">
                          {consoleScope === "all" ? (
                            <div className="section-heading-row compact-align">
                              <div>
                                <p className="section-label">{group.turns.length} 条轨迹</p>
                                <h3>{group.roomTitle}</h3>
                              </div>
                              <div className="meta-chip-row compact align-end">
                                {group.roomId === room.id ? <span className="meta-chip">当前房间</span> : null}
                                {group.roomId !== room.id ? (
                                  <Link href={`/rooms/${group.roomId}`} className="secondary-button">
                                    打开房间
                                  </Link>
                                ) : null}
                              </div>
                            </div>
                          ) : null}

                          <div className="trace-list top-gap">
                            {group.turns.map((turn, index) => renderTurnCard(turn, index, group.turns.length, group.roomId))}
                          </div>
                        </section>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}

              {inspectorTab === "room" ? (
                <div className="inspector-stack">
                  <section className="subtle-panel">
                    <p className="section-label">房间标题</p>
                    <div className="inline-action-row stretch">
                      <input
                        className="text-input"
                        value={titleDraft}
                        onChange={(event) =>
                          setTitleDraftByRoomId((current) => ({
                            ...current,
                            [room.id]: event.target.value,
                          }))
                        }
                      />
                      <button type="button" className="secondary-button" onClick={() => renameRoom(room.id, titleDraft)} disabled={!titleDraft.trim() || isRunning}>
                        保存
                      </button>
                    </div>
                  </section>
                  <RoomCronPanel room={room} className="subtle-panel" />

                  <section className="subtle-panel">
                    <div className="section-heading-row compact-align">
                      <div>
                        <p className="section-label">参与者</p>
                        <h3>管理当前房间</h3>
                      </div>
                    </div>

                    <div className="stacked-list compact-gap top-gap">
                      {room.participants.map((participant) => {
                        const isAgent = participant.runtimeKind === "agent";
                        const isOwner = participant.id === room.ownerParticipantId;
                        return (
                          <div key={participant.id} className="participant-row-card">
                            <div className="participant-meta">
                              <strong>{participant.name}</strong>
                              <p>
                                {isAgent ? `${getAgentDefinition(participant.agentId ?? primaryAgentId).summary}` : "人工参与者"}
                              </p>
                            </div>
                            <div className="participant-actions">
                              {isOwner ? <span className="meta-chip">owner</span> : null}
                              <span className="meta-chip subtle">{participant.runtimeKind}</span>
                              {isAgent ? (
                                <>
                                  <button type="button" className="mini-button" onClick={() => moveAgentParticipant(room.id, participant.id, -1)} disabled={isRunning}>
                                    上移
                                  </button>
                                  <button type="button" className="mini-button" onClick={() => moveAgentParticipant(room.id, participant.id, 1)} disabled={isRunning}>
                                    下移
                                  </button>
                                  <button type="button" className="mini-button" onClick={() => toggleAgentParticipant(room.id, participant.id)} disabled={isRunning}>
                                    {participant.enabled ? "停用" : "启用"}
                                  </button>
                                </>
                              ) : null}
                              {participant.id !== "local-operator" ? (
                                <button type="button" className="mini-button danger-text" onClick={() => removeParticipant(room.id, participant.id)} disabled={isRunning}>
                                  移除
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="inline-action-row stretch top-gap">
                      <input
                        className="text-input"
                        value={newParticipantName}
                        onChange={(event) => setNewParticipantName(event.target.value)}
                        placeholder="新增人工参与者"
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          addHumanParticipant(room.id, newParticipantName);
                          setNewParticipantName("");
                        }}
                        disabled={!newParticipantName.trim() || isRunning}
                      >
                        添加
                      </button>
                    </div>

                    <div className="agent-preset-row top-gap">
                      {agents.map((agent) => {
                        const exists = room.participants.some((participant) => participant.runtimeKind === "agent" && participant.agentId === agent.id);
                        return (
                          <button
                            key={agent.id}
                            type="button"
                            className={exists ? "preset-chip active" : "preset-chip"}
                            onClick={() => addAgentParticipant(room.id, agent.id)}
                            disabled={exists || isRunning}
                          >
                            <strong>{agent.label}</strong>
                            <span>{exists ? "已加入该房间" : "添加到当前房间"}</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  <section className="subtle-panel danger-panel">
                    <p className="section-label">危险操作</p>
                    <div className="card-actions wrap-actions">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          archiveRoom(room.id);
                          router.push("/rooms");
                        }}
                        disabled={isRunning}
                      >
                        归档房间
                      </button>
                      <button
                        type="button"
                        className="ghost-button danger-text"
                        onClick={() => {
                          if (window.confirm(`确认永久删除“${room.title}”吗？此操作不可恢复。`)) {
                            const fallback = activeRooms.find((entry) => entry.id !== room.id)?.id;
                            deleteRoom(room.id);
                            router.push(fallback ? `/rooms/${fallback}` : "/rooms");
                          }
                        }}
                        disabled={isRunning}
                      >
                        删除房间
                      </button>
                    </div>
                  </section>
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
