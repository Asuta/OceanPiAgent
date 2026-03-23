import type { RoomCronJob, RoomCronRunRecord, RoomMessage, RoomSender } from "@/lib/chat/types";
import { hasActiveAgentRoomRun } from "@/lib/server/agent-room-sessions";
import {
  computeFollowingRunAt,
  createCronRunRecord,
  loadCronStore,
  mutateCronStore,
} from "@/lib/server/cron-store";
import { runRoomTurnNonStreaming } from "@/lib/server/room-runner";
import { loadWorkspaceEnvelope, mutateWorkspace } from "@/lib/server/workspace-store";
import { applyCronTurnToWorkspace, createAgentSharedState, createTimestamp } from "@/lib/server/workspace-state";

type QueuedCronJob = {
  jobId: string;
  scheduledFor: string;
};

const CRON_TICK_MS = 15_000;
const AGENT_QUEUE_RETRY_MS = 2_000;

declare global {
  var __oceankingCronDispatcherStarted: boolean | undefined;
  var __oceankingCronInterval: NodeJS.Timeout | undefined;
  var __oceankingCronQueues: Map<string, QueuedCronJob[]> | undefined;
  var __oceankingCronProcessingAgents: Set<string> | undefined;
}

const cronQueues = globalThis.__oceankingCronQueues ?? new Map<string, QueuedCronJob[]>();
const processingAgents = globalThis.__oceankingCronProcessingAgents ?? new Set<string>();
globalThis.__oceankingCronQueues = cronQueues;
globalThis.__oceankingCronProcessingAgents = processingAgents;

function createCronSender(job: RoomCronJob): RoomSender {
  return {
    id: `cron-${job.id}`,
    name: "Scheduled Task",
    role: "system",
  };
}

function buildCronEnvelope(job: RoomCronJob): string {
  const deliveryInstructions: Record<RoomCronJob["deliveryPolicy"], string> = {
    silent: "This scheduled task is silent. Do not call send_message_to_room. Work internally only.",
    only_on_result:
      "Only call send_message_to_room if you have a concrete, worthwhile result for humans in the target room.",
    always_post_summary:
      "You must finish with at least one concise send_message_to_room message in the target room that summarizes the outcome.",
  };

  return [
    "[Scheduled room task]",
    `Job title: ${job.title}`,
    `Target room id: ${job.targetRoomId}`,
    `Delivery policy: ${job.deliveryPolicy}`,
    deliveryInstructions[job.deliveryPolicy],
    "Run the following operator instruction for the target room using the current shared memory and room context:",
    job.prompt,
  ].join("\n");
}

function summarizeRun(result: { assistantText?: string; emittedMessages: RoomMessage[] }): string {
  const firstMessage = result.emittedMessages[0]?.content.trim();
  if (firstMessage) {
    return firstMessage.length > 160 ? `${firstMessage.slice(0, 160).trim()}...` : firstMessage;
  }
  const fallback = result.assistantText?.trim() ?? "";
  if (!fallback) {
    return "No visible room output.";
  }
  return fallback.length > 160 ? `${fallback.slice(0, 160).trim()}...` : fallback;
}

function filterEmittedMessages(job: RoomCronJob, emittedMessages: RoomMessage[]): RoomMessage[] {
  if (job.deliveryPolicy === "silent") {
    return [];
  }
  return emittedMessages;
}

function enqueueJob(agentId: string, item: QueuedCronJob): void {
  const currentQueue = cronQueues.get(agentId) ?? [];
  if (currentQueue.some((queued) => queued.jobId === item.jobId && queued.scheduledFor === item.scheduledFor)) {
    return;
  }
  cronQueues.set(agentId, [...currentQueue, item]);
}

async function markJobQueued(job: RoomCronJob, scheduledFor: string): Promise<void> {
  await mutateCronStore((store) => ({
    ...store,
    jobs: store.jobs.map((entry) => {
      if (entry.id !== job.id || !entry.enabled) {
        return entry;
      }
      const nextRunAt = computeFollowingRunAt(entry.schedule, scheduledFor);
      return {
        ...entry,
        status: "queued",
        nextRunAt,
        ...(entry.schedule.type === "once" && !nextRunAt ? { enabled: false } : {}),
        updatedAt: createTimestamp(),
      } satisfies RoomCronJob;
    }),
  }));
}

async function finalizeRun(args: {
  jobId: string;
  runId: string;
  status: RoomCronRunRecord["status"];
  summary: string;
  error: string | null;
}): Promise<void> {
  await mutateCronStore((store) => ({
    ...store,
    runs: store.runs.map((run) =>
      run.id === args.runId
        ? {
            ...run,
            status: args.status,
            summary: args.summary,
            error: args.error,
            finishedAt: createTimestamp(),
          }
        : run,
    ),
    jobs: store.jobs.map((job) =>
      job.id === args.jobId
        ? {
            ...job,
            status: args.status === "completed" ? "idle" : "error",
            lastRunAt: createTimestamp(),
            lastError: args.error,
            updatedAt: createTimestamp(),
          }
        : job,
    ),
  }));
}

async function startRunRecord(job: RoomCronJob, scheduledFor: string): Promise<RoomCronRunRecord> {
  const record = createCronRunRecord(job, scheduledFor);
  await mutateCronStore((store) => ({
    ...store,
    runs: [...store.runs, record],
    jobs: store.jobs.map((entry) =>
      entry.id === job.id
        ? {
            ...entry,
            status: "running",
            lastError: null,
            updatedAt: createTimestamp(),
          }
        : entry,
    ),
  }));
  return record;
}

async function runQueuedJob(item: QueuedCronJob): Promise<void> {
  const store = await loadCronStore();
  const job = store.jobs.find((entry) => entry.id === item.jobId && entry.enabled);
  if (!job) {
    return;
  }

  const runRecord = await startRunRecord(job, item.scheduledFor);

  try {
    const workspaceEnvelope = await loadWorkspaceEnvelope();
    const room = workspaceEnvelope.state.rooms.find((entry) => entry.id === job.targetRoomId);
    if (!room) {
      throw new Error(`Target room ${job.targetRoomId} does not exist.`);
    }
    const participatesInRoom = room.participants.some(
      (participant) => participant.runtimeKind === "agent" && participant.agentId === job.agentId,
    );
    if (!participatesInRoom) {
      throw new Error(`Agent ${job.agentId} is not attached to room ${job.targetRoomId}.`);
    }

    const settings = workspaceEnvelope.state.agentStates[job.agentId]?.settings ?? createAgentSharedState().settings;
    const result = await runRoomTurnNonStreaming({
      workspace: workspaceEnvelope.state,
      roomId: job.targetRoomId,
      agentId: job.agentId,
      message: {
        id: crypto.randomUUID(),
        content: buildCronEnvelope(job),
        sender: createCronSender(job),
      },
      settings,
    });

    if (result.turn.status === "error") {
      throw new Error(result.turn.error || "Scheduled task failed.");
    }

    const emittedMessages = filterEmittedMessages(job, result.emittedMessages);
    if (job.deliveryPolicy === "always_post_summary" && emittedMessages.length === 0) {
      throw new Error("Cron job did not emit any send_message_to_room output.");
    }

    const visibleTurn = {
      ...result.turn,
      emittedMessages,
    };

    await mutateWorkspace((workspace) =>
      applyCronTurnToWorkspace({
        workspace,
        agentId: job.agentId,
        targetRoomId: job.targetRoomId,
        turn: visibleTurn,
        resolvedModel: result.resolvedModel,
        compatibility: result.compatibility,
        emittedMessages,
        receiptUpdates: result.receiptUpdates,
        roomActions: result.roomActions,
      }),
    );

    await finalizeRun({
      jobId: job.id,
      runId: runRecord.id,
      status: "completed",
      summary: summarizeRun({
        assistantText: result.turn.assistantContent,
        emittedMessages,
      }),
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown cron error.";
    await finalizeRun({
      jobId: job.id,
      runId: runRecord.id,
      status: "failed",
      summary: "",
      error: message,
    });
  }
}

async function processAgentQueue(agentId: string): Promise<void> {
  if (processingAgents.has(agentId)) {
    return;
  }

  if (hasActiveAgentRoomRun(agentId as RoomCronJob["agentId"])) {
    setTimeout(() => {
      void processAgentQueue(agentId);
    }, AGENT_QUEUE_RETRY_MS).unref?.();
    return;
  }

  const queue = cronQueues.get(agentId) ?? [];
  const next = queue[0];
  if (!next) {
    return;
  }

  processingAgents.add(agentId);
  cronQueues.set(agentId, queue.slice(1));

  try {
    await runQueuedJob(next);
  } finally {
    processingAgents.delete(agentId);
    if ((cronQueues.get(agentId) ?? []).length > 0) {
      void processAgentQueue(agentId);
    }
  }
}

async function tickCronJobs(): Promise<void> {
  const store = await loadCronStore();
  const now = Date.now();
  const dueJobs = store.jobs.filter(
    (job) => job.enabled && job.nextRunAt && Date.parse(job.nextRunAt) <= now && job.status !== "queued" && job.status !== "running",
  );

  for (const job of dueJobs) {
    const scheduledFor = job.nextRunAt as string;
    await markJobQueued(job, scheduledFor);
    enqueueJob(job.agentId, { jobId: job.id, scheduledFor });
    void processAgentQueue(job.agentId);
  }
}

export async function enqueueCronJobNow(jobId: string): Promise<void> {
  const store = await loadCronStore();
  const job = store.jobs.find((entry) => entry.id === jobId);
  if (!job) {
    throw new Error("Cron job not found.");
  }
  const scheduledFor = createTimestamp();
  await markJobQueued(job, scheduledFor);
  enqueueJob(job.agentId, { jobId: job.id, scheduledFor });
  void processAgentQueue(job.agentId);
}

export function ensureCronDispatcherStarted(): void {
  if (globalThis.__oceankingCronDispatcherStarted) {
    return;
  }
  globalThis.__oceankingCronDispatcherStarted = true;
  globalThis.__oceankingCronInterval = setInterval(() => {
    void tickCronJobs();
  }, CRON_TICK_MS);
  globalThis.__oceankingCronInterval.unref?.();
  void tickCronJobs();
}
