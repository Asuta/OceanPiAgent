import { formatTimestamp } from "@/components/workspace-provider";
import type { RoomThreadDraftEntry } from "@/components/workspace/room-thread";

const TURN_STATUS_LABELS = {
  running: "生成中",
  continued: "续跑中",
  completed: "已收起",
  error: "已结束",
} as const;

export function DraftHistoryInline({
  entry,
  defaultOpen,
}: {
  entry: RoomThreadDraftEntry;
  defaultOpen?: boolean;
}) {
  const isActive = entry.segment.status === "streaming";

  return (
    <details className={`thread-draft-inline${isActive ? " is-active" : ""}${entry.turn.status === "error" ? " is-error" : ""}`} open={defaultOpen}>
      <summary className="thread-draft-summary">
        <div className="thread-draft-summary-main">
          <span className="thread-draft-kicker">草稿流</span>
          <strong>{isActive ? "草稿输出中" : "草稿记录"}</strong>
          <span>{entry.turn.agent.label}</span>
        </div>
        <div className="thread-draft-summary-meta">
          <span className="meta-chip subtle">{isActive ? "生成中" : TURN_STATUS_LABELS[entry.turn.status]}</span>
          <span className="thread-draft-summary-time">{formatTimestamp(entry.turn.userMessage.createdAt)}</span>
        </div>
      </summary>

      <div className="thread-draft-body">
        <pre>{entry.segment.content || "(waiting for draft output)"}</pre>
        {entry.turn.error ? <p className="error-text">{entry.turn.error}</p> : null}
      </div>
    </details>
  );
}
