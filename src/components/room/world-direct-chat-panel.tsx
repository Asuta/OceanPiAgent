"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { MarkdownMessage } from "@/components/markdown-message";
import { useRoomDetailState } from "@/components/room/use-room-detail-state";
import { buildWorldDirectThreadTimeline } from "@/components/room/world-direct-thread";
import { DraftHistoryInline } from "@/components/workspace/draft-history-inline";
import { ToolHistoryInline } from "@/components/workspace/tool-history-inline";
import {
  formatTimestamp,
  useWorkspaceActions,
  useWorkspaceAgentsState,
  useWorkspaceRoomsState,
} from "@/components/workspace-provider";
import type { RoomAgentId, RoomMessage, RoomMessageReceipt } from "@/lib/chat/types";

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

function getMessageKicker(message: RoomMessage) {
  if (message.role === "user") {
    return "你";
  }

  if (message.role === "system") {
    return "系统";
  }

  return message.kind === "answer" ? "Agent" : ROOM_KIND_LABELS[message.kind];
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
  if (message.role === "assistant" && message.status === "streaming") {
    parts.push("is-streaming");
  }
  return parts.join(" ");
}

function formatReceiptNames(receipts: RoomMessageReceipt[]) {
  return receipts.map((receipt) => `✓ ${receipt.participantName}`).join("  ");
}

export function WorldDirectChatPanel({
  roomId,
  agentId,
  onClose,
}: {
  roomId: string;
  agentId: RoomAgentId;
  onClose: () => void;
}) {
  const { rooms, draftsByRoomId, selectedSenderByRoomId } = useWorkspaceRoomsState();
  const { agentStates, selectedConsoleAgentId, workspaceRuntimeState } = useWorkspaceAgentsState();
  const {
    getRoomById,
    getAgentDefinition,
    setDraft,
    setSelectedConsoleAgentId,
    setSelectedSender,
    sendMessage,
    isRoomRunning,
    stopRoom,
  } = useWorkspaceActions();

  const room = getRoomById(roomId);
  const agent = getAgentDefinition(agentId);
  const threadListRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setSelectedConsoleAgentId(agent.id);
  }, [agent.id, setSelectedConsoleAgentId]);

  const {
    roomThreadToolEntries,
    roomThreadDraftEntries,
    threadScrollKey,
    roomDraft,
    availableSenders,
    selectedSender,
    canSend,
  } = useRoomDetailState({
    roomId,
    room,
    rooms,
    agentStates,
    draftsByRoomId,
    selectedConsoleAgentId,
    selectedSenderByRoomId,
    pendingAttachments: [],
    isUploadingImages: false,
    titleDraftByRoomId: {},
    consoleScope: "room",
  });

  const timeline = useMemo(
    () =>
      room
        ? buildWorldDirectThreadTimeline({
            roomMessages: room.roomMessages,
            toolEntriesByAnchor: roomThreadToolEntries,
            draftEntriesByAnchor: roomThreadDraftEntries,
          })
        : [],
    [room, roomThreadDraftEntries, roomThreadToolEntries],
  );

  const isRunning = room ? isRoomRunning(room.id) : false;
  const runtimeState = workspaceRuntimeState.agentStates[agent.id];

  useLayoutEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [roomDraft]);

  useLayoutEffect(() => {
    const threadList = threadListRef.current;
    if (!threadList) {
      return;
    }

    threadList.scrollTop = threadList.scrollHeight;
  }, [threadScrollKey, timeline.length]);

  const submitMessage = useCallback(async () => {
    if (!room || !selectedSender || !canSend) {
      return;
    }

    const contentToSend = roomDraft;
    setDraft(room.id, "");
    try {
      await sendMessage({
        roomId: room.id,
        content: contentToSend,
        senderId: selectedSender.id,
      });
    } catch {
      setDraft(room.id, contentToSend);
    }
  }, [canSend, room, roomDraft, selectedSender, sendMessage, setDraft]);

  if (!room) {
    return (
      <aside className="surface-panel world-chat-panel">
        <div className="world-chat-placeholder">
          <p className="section-label">Direct Chat</p>
          <h3>正在打开 {agent.label} 的单聊房间...</h3>
        </div>
      </aside>
    );
  }

  return (
    <aside className="surface-panel world-chat-panel">
      <div className="world-chat-panel-header">
        <div>
          <p className="section-label">Direct Chat</p>
          <h2>{agent.label}</h2>
          <p className="muted-copy">
            {runtimeState ? `正在使用 ${runtimeState.toolName}` : isRunning ? "正在回复中" : "现在在休息区，可以直接聊天"}
          </p>
        </div>
        <div className="world-chat-panel-actions">
          <Link href={`/rooms/${room.id}`} className="secondary-button">
            打开完整房间
          </Link>
          <button type="button" className="ghost-button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      {isRunning ? (
        <div className="thread-live-banner world-chat-live-banner" role="status" aria-live="polite">
          <div className="thread-live-copy">
            <strong>{agent.label} 正在继续处理这次对话</strong>
            <p>你可以继续等，也可以直接发新消息接管当前上下文。</p>
          </div>
          <button type="button" className="ghost-button" onClick={() => void stopRoom(room.id)}>
            停止当前回复
          </button>
          <span className="thread-live-badge">live</span>
        </div>
      ) : null}

      <div ref={threadListRef} className="thread-list world-chat-thread-list">
        {timeline.length === 0 ? (
          <div className="empty-panel thread-empty">
            <p className="section-label">Ready</p>
            <h3>和 {agent.label} 开始单聊</h3>
            <p>这里会显示消息、工具调用和草稿流，但不展示成员管理或完整日志设置。</p>
          </div>
        ) : (
          timeline.map((entry, index) => {
            if (entry.kind === "tool") {
              return <ToolHistoryInline key={entry.id} entry={entry.entry} defaultOpen={false} />;
            }

            if (entry.kind === "draft") {
              return <DraftHistoryInline key={entry.id} entry={entry.entry} defaultOpen={entry.entry.segment.status === "streaming"} />;
            }

            const message = entry.message;
            const shouldShowState = message.role === "assistant" && (message.kind !== "answer" || message.status !== "completed");
            const shouldRenderMarkdown = message.role === "assistant" || message.source === "agent_emit";
            const isLatestMessage = index === timeline.length - 1;

            return (
              <article key={entry.id} className={`${getMessageCardClass(message)}${isLatestMessage ? " is-latest" : ""}`}>
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

                  {message.content ? (
                    shouldRenderMarkdown ? (
                      <MarkdownMessage className="thread-message-body markdown-body" content={message.content} />
                    ) : (
                      <div className="thread-message-body">{message.content}</div>
                    )
                  ) : null}

                  {message.attachments.length > 0 ? (
                    <div className="message-image-grid">
                      {message.attachments.map((attachment) => (
                        <a key={attachment.id} className="message-image-link" href={attachment.url} target="_blank" rel="noreferrer">
                          <Image src={attachment.url} alt={attachment.filename} className="message-image-preview" width={240} height={180} unoptimized />
                          <span>{attachment.filename}</span>
                        </a>
                      ))}
                    </div>
                  ) : null}

                  {message.receipts.length > 0 ? <div className="message-receipt-note">{formatReceiptNames(message.receipts)}</div> : null}
                </div>
              </article>
            );
          })
        )}
      </div>

      <form
        className="composer-card compact-composer world-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submitMessage();
        }}
      >
        <div className="composer-toolbar">
          <div className="composer-tool-group">
            {availableSenders.length > 1 ? (
              <label className="field-block inline-field compact-width composer-inline-field" htmlFor={`world-room-sender-${room.id}`}>
                <span className="composer-inline-label">发送身份</span>
                <select
                  id={`world-room-sender-${room.id}`}
                  className="text-input composer-select"
                  value={selectedSender?.id ?? ""}
                  onChange={(event) => setSelectedSender(room.id, event.target.value)}
                  disabled={isRunning}
                >
                  {availableSenders.map((participant) => (
                    <option key={participant.id} value={participant.id}>
                      {participant.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="composer-note">你正在和 {agent.label} 单聊</span>
            )}
          </div>
          <div className="composer-action-cluster">
            <span className={`thread-status ${isRunning ? "running" : "idle"}`}>{isRunning ? "Agent 处理中" : canSend ? "可发送" : "待输入"}</span>
            <button type="submit" className="primary-button composer-send-button" disabled={!canSend}>
              发送
            </button>
          </div>
        </div>

        <div className="composer-input-shell">
          <textarea
            ref={composerTextareaRef}
            className="text-area composer-textarea"
            value={roomDraft}
            onChange={(event) => setDraft(room.id, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitMessage();
              }
            }}
            placeholder={`给 ${agent.label} 发条消息，Enter 发送，Shift + Enter 换行...`}
          />
        </div>

        {room.error ? <p className="error-text">{room.error}</p> : null}
      </form>
    </aside>
  );
}
