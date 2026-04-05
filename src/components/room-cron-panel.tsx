"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CronDeliveryPolicy, RoomAgentId, RoomCronJob, RoomCronRunRecord, RoomCronSchedule, RoomSession } from "@/lib/chat/types";
import { DEFAULT_AGENT_ID, useWorkspaceAgents } from "@/components/workspace-provider";

type Props = {
  room: RoomSession;
  className?: string;
};

type CronResponse = {
  jobs?: RoomCronJob[];
  runs?: RoomCronRunRecord[];
  error?: string;
};

type ScheduleType = RoomCronSchedule["type"];

const DELIVERY_OPTIONS: Array<{ value: CronDeliveryPolicy; label: string }> = [
  { value: "silent", label: "Silent" },
  { value: "only_on_result", label: "Only On Result" },
  { value: "always_post_summary", label: "Always Post Summary" },
];

const WEEKDAY_OPTIONS = [
  { value: 0, label: "周日" },
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
];

function formatSchedule(schedule: RoomCronSchedule): string {
  if (schedule.type === "once") {
    const date = new Date(schedule.at);
    return Number.isNaN(date.getTime()) ? schedule.at : date.toLocaleString();
  }
  if (schedule.type === "daily") {
    return `每天 ${schedule.time}`;
  }
  return `${WEEKDAY_OPTIONS.find((option) => option.value === schedule.dayOfWeek)?.label ?? "每周"} ${schedule.time}`;
}

function toDatetimeLocalValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function defaultOnceValue(): string {
  const nextHour = new Date();
  nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
  return toDatetimeLocalValue(nextHour.toISOString());
}

export function RoomCronPanel({ room, className }: Props) {
  const agents = useWorkspaceAgents();
  const roomAgentIds = useMemo<RoomAgentId[]>(
    () =>
      room.participants
        .filter((participant): participant is typeof participant & { agentId: RoomAgentId } => participant.runtimeKind === "agent" && Boolean(participant.agentId))
        .map((participant) => participant.agentId),
    [room.participants],
  );
  const [jobs, setJobs] = useState<RoomCronJob[]>([]);
  const [runs, setRuns] = useState<RoomCronRunRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("Morning Summary");
  const [prompt, setPrompt] = useState("请总结这个房间最近的重要进展，并给出下一步建议。");
  const [agentId, setAgentId] = useState<RoomAgentId>(roomAgentIds[0] ?? DEFAULT_AGENT_ID);
  const [scheduleType, setScheduleType] = useState<ScheduleType>("daily");
  const [onceAt, setOnceAt] = useState(defaultOnceValue());
  const [dailyTime, setDailyTime] = useState("09:00");
  const [weeklyDay, setWeeklyDay] = useState(1);
  const [weeklyTime, setWeeklyTime] = useState("09:00");
  const [deliveryPolicy, setDeliveryPolicy] = useState<CronDeliveryPolicy>("only_on_result");
  const selectedAgentId = roomAgentIds.includes(agentId) ? agentId : (roomAgentIds[0] ?? DEFAULT_AGENT_ID);
  const agentLabelById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.label])), [agents]);
  const panelClassName = className ?? "surface-panel page-enter page-enter-delay-1";

  const refresh = useCallback(async () => {
    setLoading(true);
    const response = await fetch(`/api/cron?roomId=${encodeURIComponent(room.id)}`, { cache: "no-store" }).catch(() => null);
    const payload = response?.ok ? ((await response.json().catch(() => null)) as CronResponse | null) : null;
    if (!response?.ok || !payload) {
      setLoading(false);
      return;
    }
    setJobs(payload.jobs ?? []);
    setRuns(payload.runs ?? []);
    setLoading(false);
  }, [room.id]);

  useEffect(() => {
    const initialTimer = setTimeout(() => {
      void refresh();
    }, 0);
    const interval = setInterval(() => {
      void refresh();
    }, 15_000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [refresh]);

  const buildSchedule = (): RoomCronSchedule => {
    if (scheduleType === "once") {
      return {
        type: "once",
        at: new Date(onceAt).toISOString(),
      };
    }
    if (scheduleType === "daily") {
      return {
        type: "daily",
        time: dailyTime,
      };
    }
    return {
      type: "weekly",
      dayOfWeek: weeklyDay,
      time: weeklyTime,
    };
  };

  const createJob = async () => {
    setSubmitting(true);
    setError("");
    const response = await fetch("/api/cron", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId: selectedAgentId,
        targetRoomId: room.id,
        title,
        prompt,
        schedule: buildSchedule(),
        deliveryPolicy,
        enabled: true,
      }),
    }).catch(() => null);

    const payload = (await response?.json().catch(() => null)) as CronResponse | null;
    if (!response?.ok || !payload) {
      setError(payload?.error ?? "创建定时任务失败。");
      setSubmitting(false);
      return;
    }

    setJobs(payload.jobs ?? []);
    setRuns(payload.runs ?? []);
    setSubmitting(false);
  };

  const runNow = async (jobId: string) => {
    await fetch(`/api/cron/${jobId}/run`, { method: "POST" }).catch(() => null);
    void refresh();
  };

  const toggleEnabled = async (job: RoomCronJob) => {
    await fetch(`/api/cron/${job.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: !job.enabled }),
    }).catch(() => null);
    void refresh();
  };

  const removeJob = async (jobId: string) => {
    await fetch(`/api/cron/${jobId}`, { method: "DELETE" }).catch(() => null);
    void refresh();
  };

  return (
    <section className={panelClassName}>
      <div className="thread-panel-header">
        <div>
          <p className="section-label">Room Cron</p>
          <h2>定时任务</h2>
          <p className="thread-panel-copy">只做明确时间点触发的任务；heartbeat 风格的巡检暂时不在这里。</p>
        </div>
        <span className="thread-status idle">{loading ? "同步中" : `${jobs.length} 个任务`}</span>
      </div>

      <div className="form-grid two-columns">
        <label className="field-block">
          <span>执行 Agent</span>
          <select className="text-input" value={selectedAgentId} onChange={(event) => setAgentId(event.target.value as RoomAgentId)}>
            {roomAgentIds.map((id) => (
              <option key={id} value={id}>
                {agentLabelById.get(id) ?? id}
              </option>
            ))}
          </select>
        </label>

        <label className="field-block">
          <span>投递策略</span>
          <select className="text-input" value={deliveryPolicy} onChange={(event) => setDeliveryPolicy(event.target.value as CronDeliveryPolicy)}>
            {DELIVERY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field-block">
          <span>任务标题</span>
          <input className="text-input" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>

        <label className="field-block">
          <span>调度方式</span>
          <select className="text-input" value={scheduleType} onChange={(event) => setScheduleType(event.target.value as ScheduleType)}>
            <option value="once">单次</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
          </select>
        </label>

        {scheduleType === "once" ? (
          <label className="field-block">
            <span>执行时间</span>
            <input className="text-input" type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} />
          </label>
        ) : null}

        {scheduleType === "daily" ? (
          <label className="field-block">
            <span>每天时间</span>
            <input className="text-input" type="time" value={dailyTime} onChange={(event) => setDailyTime(event.target.value)} />
          </label>
        ) : null}

        {scheduleType === "weekly" ? (
          <>
            <label className="field-block">
              <span>每周日期</span>
              <select className="text-input" value={weeklyDay} onChange={(event) => setWeeklyDay(Number(event.target.value))}>
                {WEEKDAY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field-block">
              <span>每周时间</span>
              <input className="text-input" type="time" value={weeklyTime} onChange={(event) => setWeeklyTime(event.target.value)} />
            </label>
          </>
        ) : null}
      </div>

      <label className="field-block top-gap">
        <span>任务 Prompt</span>
        <textarea className="text-area compact" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      </label>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="card-actions compact-right top-gap">
        <button type="button" className="secondary-button" onClick={() => void refresh()}>
          刷新
        </button>
        <button type="button" className="primary-button" disabled={submitting || roomAgentIds.length === 0} onClick={() => void createJob()}>
          {submitting ? "创建中..." : "新增定时任务"}
        </button>
      </div>

      <div className="stacked-list top-gap">
        {jobs.length === 0 ? <div className="subtle-panel">当前房间还没有定时任务。</div> : null}
        {jobs.map((job) => (
          <article key={job.id} className="subtle-panel">
            <div className="thread-panel-header">
              <div>
                <p className="section-label">{job.agentId}</p>
                <h3>{job.title}</h3>
                <p>{formatSchedule(job.schedule)}</p>
              </div>
              <div className="meta-chip-row compact align-end">
                <span className="meta-chip subtle">{job.deliveryPolicy}</span>
                <span className="meta-chip subtle">{job.enabled ? "enabled" : "disabled"}</span>
                <span className="meta-chip">{job.status}</span>
              </div>
            </div>
            <p>{job.prompt}</p>
            <div className="meta-chip-row compact top-gap">
              <span className="meta-chip subtle">next: {job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "none"}</span>
              <span className="meta-chip subtle">last: {job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "never"}</span>
            </div>
            {job.lastError ? <p className="error-text">{job.lastError}</p> : null}
            <div className="card-actions compact-right top-gap">
              <button type="button" className="ghost-button" onClick={() => void toggleEnabled(job)}>
                {job.enabled ? "停用" : "启用"}
              </button>
              <button type="button" className="secondary-button" onClick={() => void runNow(job.id)}>
                立即执行
              </button>
              <button type="button" className="ghost-button" onClick={() => void removeJob(job.id)}>
                删除
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="stacked-list top-gap">
        <div className="section-heading-row">
          <div>
            <p className="section-label">Recent Runs</p>
            <strong>最近执行记录</strong>
          </div>
        </div>
        {runs.length === 0 ? <div className="subtle-panel">还没有执行记录。</div> : null}
        {runs.slice(0, 8).map((run) => (
          <article key={run.id} className="subtle-panel">
            <div className="thread-panel-header">
              <div>
                <p className="section-label">{run.status}</p>
                <strong>{run.summary || "No summary"}</strong>
              </div>
              <span className="meta-chip subtle">{new Date(run.startedAt).toLocaleString()}</span>
            </div>
            {run.error ? <p className="error-text">{run.error}</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}
