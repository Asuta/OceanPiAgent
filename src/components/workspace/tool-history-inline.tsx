import { formatTimestamp } from "@/components/workspace-provider";
import type { RoomThreadToolEntry } from "@/components/workspace/room-thread";

const TURN_STATUS_LABELS = {
  running: "执行中",
  continued: "已续跑",
  completed: "已完成",
  error: "失败",
} as const;

export function ToolHistoryInline({
  entry,
  defaultOpen,
}: {
  entry: RoomThreadToolEntry;
  defaultOpen?: boolean;
}) {
  const statusLabel = entry.tool.status === "success" ? "成功" : "失败";

  return (
    <details className={`thread-tool-inline${entry.turn.status !== "completed" ? " is-active" : ""}${entry.tool.status === "error" || entry.turn.error ? " is-error" : ""}`} open={defaultOpen}>
      <summary className="thread-tool-summary">
        <div className="thread-tool-summary-main">
          <span className="thread-tool-kicker">工具调用</span>
          <strong>{entry.tool.displayName}</strong>
          <span>{entry.turn.agent.label}</span>
        </div>
        <div className="thread-tool-summary-meta">
          <span className="meta-chip subtle">{TURN_STATUS_LABELS[entry.turn.status]}</span>
          <span className="meta-chip subtle">{statusLabel}</span>
          <span className="meta-chip subtle">{entry.tool.durationMs} ms</span>
          {entry.tool.roomMessage ? <span className="meta-chip subtle">发回房间</span> : null}
          {entry.tool.roomAction ? <span className="meta-chip subtle">房间动作</span> : null}
          <span className="thread-tool-summary-time">{formatTimestamp(entry.turn.userMessage.createdAt)}</span>
        </div>
      </summary>

      <div className="thread-tool-body">
        <div className="code-pair-grid">
          <pre>{entry.tool.inputText || "(empty)"}</pre>
          <pre>{entry.tool.outputText || "(empty)"}</pre>
        </div>
        {entry.turn.error ? <p className="error-text">{entry.turn.error}</p> : null}
      </div>
    </details>
  );
}
