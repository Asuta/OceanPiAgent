import type {
  CronDeliveryPolicy,
  RoomAgentId,
  RoomCronJob,
  RoomCronJobStatus,
  RoomCronRunRecord,
  RoomCronRunStatus,
  RoomCronSchedule,
} from "@/lib/chat/types";
import { enqueueCronJobNow } from "@/lib/server/cron-dispatcher";
import {
  computeFollowingRunAt,
  computeNextRunAt,
  createCronJob,
  describeSchedule,
  loadCronStore,
  mutateCronStore,
} from "@/lib/server/cron-store";
import { loadWorkspaceEnvelope } from "@/lib/server/workspace-store";

export interface CronAccessScope {
  agentId?: RoomAgentId;
  targetRoomIds?: string[];
}

export interface ListCronJobsOptions extends CronAccessScope {
  roomId?: string;
  status?: RoomCronJobStatus;
  enabled?: boolean;
  limit?: number;
}

export interface ListCronRunsOptions extends CronAccessScope {
  jobId?: string;
  roomId?: string;
  status?: RoomCronRunStatus;
  limit?: number;
}

export interface GetCronJobDetailsOptions extends CronAccessScope {
  runLimit?: number;
}

export interface CreateCronJobInput {
  agentId: RoomAgentId;
  targetRoomId: string;
  title: string;
  prompt: string;
  schedule: RoomCronSchedule;
  deliveryPolicy: CronDeliveryPolicy;
  enabled?: boolean;
}

export interface UpdateCronJobInput {
  agentId?: RoomAgentId;
  targetRoomId?: string;
  title?: string;
  prompt?: string;
  schedule?: RoomCronSchedule;
  deliveryPolicy?: CronDeliveryPolicy;
  enabled?: boolean;
}

function createTimestamp(): string {
  return new Date().toISOString();
}

function matchesScope(entry: Pick<RoomCronJob, "agentId" | "targetRoomId"> | Pick<RoomCronRunRecord, "agentId" | "targetRoomId">, scope?: CronAccessScope): boolean {
  if (scope?.agentId && entry.agentId !== scope.agentId) {
    return false;
  }
  if (scope?.targetRoomIds && !scope.targetRoomIds.includes(entry.targetRoomId)) {
    return false;
  }
  return true;
}

function normalizeLimit(limit?: number): number | null {
  if (!Number.isFinite(limit)) {
    return null;
  }
  return Math.max(1, Math.min(200, Math.floor(limit as number)));
}

function applyLimit<T>(entries: T[], limit?: number): T[] {
  const normalized = normalizeLimit(limit);
  return normalized ? entries.slice(0, normalized) : entries;
}

function sortRunsNewestFirst(runs: RoomCronRunRecord[]): RoomCronRunRecord[] {
  return [...runs].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

function assertScopeAllowsAgent(agentId: RoomAgentId, scope?: CronAccessScope): void {
  if (scope?.agentId && scope.agentId !== agentId) {
    throw new Error(`This cron scope is limited to agent ${scope.agentId}.`);
  }
}

function assertScopeAllowsRoom(targetRoomId: string, scope?: CronAccessScope): void {
  if (scope?.targetRoomIds && !scope.targetRoomIds.includes(targetRoomId)) {
    throw new Error(`Room ${targetRoomId} is outside the current cron management scope.`);
  }
}

function computeEnabledNextRunAt(schedule: RoomCronSchedule): string {
  const nextRunAt = computeNextRunAt(schedule);
  if (!nextRunAt) {
    throw new Error("Enabled cron jobs must have a future execution time.");
  }
  return nextRunAt;
}

function getScopedCronJobOrThrow(store: Awaited<ReturnType<typeof loadCronStore>>, jobId: string, scope?: CronAccessScope): RoomCronJob {
  const job = store.jobs.find((entry) => entry.id === jobId && matchesScope(entry, scope));
  if (!job) {
    throw new Error("Cron job not found.");
  }
  return job;
}

function assertJobCanBeEdited(job: RoomCronJob, patch: UpdateCronJobInput): void {
  const isDisableOnly = patch.enabled === false && Object.keys(patch).length === 1;
  if ((job.status === "queued" || job.status === "running") && !isDisableOnly) {
    throw new Error("Queued or running cron jobs can only be paused or deleted until the active run finishes.");
  }
}

async function validateJobTarget(agentId: RoomAgentId, targetRoomId: string): Promise<void> {
  const workspace = await loadWorkspaceEnvelope();
  const room = workspace.state.rooms.find((entry) => entry.id === targetRoomId);
  if (!room) {
    throw new Error(`Room ${targetRoomId} does not exist.`);
  }
  const participatesInRoom = room.participants.some(
    (participant) => participant.runtimeKind === "agent" && participant.agentId === agentId,
  );
  if (!participatesInRoom) {
    throw new Error(`Agent ${agentId} is not attached to room ${targetRoomId}.`);
  }
}

export function previewCronSchedule(schedule: RoomCronSchedule, now = new Date()) {
  const nextRunAt = computeNextRunAt(schedule, now);
  return {
    schedule,
    description: describeSchedule(schedule),
    nextRunAt,
    followingRunAt: nextRunAt ? computeFollowingRunAt(schedule, nextRunAt) : null,
  };
}

export async function listCronJobs(options: ListCronJobsOptions = {}): Promise<RoomCronJob[]> {
  const store = await loadCronStore();
  const jobs = store.jobs.filter((job) => {
    if (!matchesScope(job, options)) {
      return false;
    }
    if (options.roomId && job.targetRoomId !== options.roomId) {
      return false;
    }
    if (options.status && job.status !== options.status) {
      return false;
    }
    if (typeof options.enabled === "boolean" && job.enabled !== options.enabled) {
      return false;
    }
    return true;
  });
  return applyLimit(jobs, options.limit);
}

export async function listCronRuns(options: ListCronRunsOptions = {}): Promise<RoomCronRunRecord[]> {
  const store = await loadCronStore();
  const runs = sortRunsNewestFirst(
    store.runs.filter((run) => {
      if (!matchesScope(run, options)) {
        return false;
      }
      if (options.jobId && run.jobId !== options.jobId) {
        return false;
      }
      if (options.roomId && run.targetRoomId !== options.roomId) {
        return false;
      }
      if (options.status && run.status !== options.status) {
        return false;
      }
      return true;
    }),
  );
  return applyLimit(runs, options.limit);
}

export async function getCronJobDetails(jobId: string, options: GetCronJobDetailsOptions = {}): Promise<{
  job: RoomCronJob;
  runs: RoomCronRunRecord[];
}> {
  const store = await loadCronStore();
  const job = getScopedCronJobOrThrow(store, jobId, options);
  const runs = applyLimit(
    sortRunsNewestFirst(store.runs.filter((run) => run.jobId === job.id && matchesScope(run, options))),
    options.runLimit,
  );
  return { job, runs };
}

export async function createManagedCronJob(input: CreateCronJobInput, scope?: CronAccessScope): Promise<RoomCronJob> {
  assertScopeAllowsAgent(input.agentId, scope);
  assertScopeAllowsRoom(input.targetRoomId, scope);
  await validateJobTarget(input.agentId, input.targetRoomId);

  const enabled = input.enabled ?? true;
  if (enabled) {
    computeEnabledNextRunAt(input.schedule);
  }

  const job = createCronJob({
    ...input,
    enabled,
  });

  const store = await mutateCronStore((current) => ({
    ...current,
    jobs: [job, ...current.jobs],
  }));
  return getScopedCronJobOrThrow(store, job.id, scope);
}

export async function updateManagedCronJob(jobId: string, patch: UpdateCronJobInput, scope?: CronAccessScope): Promise<RoomCronJob> {
  const currentStore = await loadCronStore();
  const currentJob = getScopedCronJobOrThrow(currentStore, jobId, scope);
  assertJobCanBeEdited(currentJob, patch);

  const nextAgentId = patch.agentId ?? currentJob.agentId;
  const nextTargetRoomId = patch.targetRoomId ?? currentJob.targetRoomId;
  const nextSchedule = patch.schedule ?? currentJob.schedule;
  const enabled = patch.enabled ?? currentJob.enabled;
  const nextRunAt = enabled ? computeEnabledNextRunAt(nextSchedule) : null;

  assertScopeAllowsAgent(nextAgentId, scope);
  assertScopeAllowsRoom(nextTargetRoomId, scope);
  await validateJobTarget(nextAgentId, nextTargetRoomId);

  const store = await mutateCronStore((snapshot) => ({
    ...snapshot,
    jobs: snapshot.jobs.map((job) => {
      if (job.id !== jobId) {
        return job;
      }
      return {
        ...job,
        agentId: nextAgentId,
        targetRoomId: nextTargetRoomId,
        title: patch.title ?? job.title,
        prompt: patch.prompt ?? job.prompt,
        schedule: nextSchedule,
        deliveryPolicy: patch.deliveryPolicy ?? job.deliveryPolicy,
        enabled,
        status: job.status === "running" ? "running" : "idle",
        nextRunAt,
        updatedAt: createTimestamp(),
      } satisfies RoomCronJob;
    }),
  }));

  return getScopedCronJobOrThrow(store, jobId, scope);
}

export async function pauseManagedCronJob(jobId: string, scope?: CronAccessScope): Promise<RoomCronJob> {
  const currentStore = await loadCronStore();
  const currentJob = getScopedCronJobOrThrow(currentStore, jobId, scope);
  const store = await mutateCronStore((snapshot) => ({
    ...snapshot,
    jobs: snapshot.jobs.map((job) =>
      job.id === jobId
        ? {
            ...job,
            enabled: false,
            status: job.status === "running" ? "running" : "idle",
            nextRunAt: null,
            updatedAt: createTimestamp(),
          }
        : job,
    ),
  }));
  return getScopedCronJobOrThrow(store, currentJob.id, scope);
}

export async function resumeManagedCronJob(jobId: string, scope?: CronAccessScope): Promise<RoomCronJob> {
  const currentStore = await loadCronStore();
  const currentJob = getScopedCronJobOrThrow(currentStore, jobId, scope);
  if (currentJob.status === "queued" || currentJob.status === "running") {
    throw new Error("Queued or running cron jobs cannot be resumed because they are already active.");
  }

  const nextRunAt = computeEnabledNextRunAt(currentJob.schedule);
  const store = await mutateCronStore((snapshot) => ({
    ...snapshot,
    jobs: snapshot.jobs.map((job) =>
      job.id === jobId
        ? {
            ...job,
            enabled: true,
            status: "idle",
            nextRunAt,
            updatedAt: createTimestamp(),
          }
        : job,
    ),
  }));
  return getScopedCronJobOrThrow(store, currentJob.id, scope);
}

export async function deleteManagedCronJob(jobId: string, scope?: CronAccessScope): Promise<void> {
  const currentStore = await loadCronStore();
  getScopedCronJobOrThrow(currentStore, jobId, scope);
  await mutateCronStore((snapshot) => ({
    ...snapshot,
    jobs: snapshot.jobs.filter((job) => job.id !== jobId),
  }));
}

export async function runManagedCronJobNow(jobId: string, scope?: CronAccessScope): Promise<RoomCronJob> {
  const currentStore = await loadCronStore();
  const job = getScopedCronJobOrThrow(currentStore, jobId, scope);
  if (job.status === "queued" || job.status === "running") {
    throw new Error("Cron job is already queued or running.");
  }
  await enqueueCronJobNow(jobId);
  const latestStore = await loadCronStore();
  return getScopedCronJobOrThrow(latestStore, jobId, scope);
}
