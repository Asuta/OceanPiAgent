import { z } from "zod";
import {
  createManagedCronJob,
  deleteManagedCronJob,
  getCronJobDetails,
  listCronJobs,
  listCronRuns,
  pauseManagedCronJob,
  previewCronSchedule,
  resumeManagedCronJob,
  runManagedCronJobNow,
  updateManagedCronJob,
} from "@/lib/server/cron-service";
import {
  buildCronRoomTitleMap,
  buildCronSchedule,
  createStructuredOutput,
  cronCreateArgsSchema,
  cronGetJobArgsSchema,
  cronJobActionArgsSchema,
  cronListJobsArgsSchema,
  cronListRunsArgsSchema,
  cronPreviewArgsSchema,
  cronUpdateArgsSchema,
  formatCronJobOutput,
  formatCronRunOutput,
  getAttachedRoom,
  getCronScope,
  resolveCronTargetRoomId,
  type ToolDefinition,
} from "./shared";

export const cronTools = {
  list_cron_jobs: {
    name: "list_cron_jobs",
    displayName: "List Cron Jobs",
    description:
      "List scheduled tasks owned by the current agent across its attached rooms. You can optionally filter by targetRoomId, status, enabled state, and limit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        targetRoomId: { type: "string", description: "Optional attached room id to filter scheduled tasks." },
        status: { type: "string", enum: ["idle", "queued", "running", "error"], description: "Optional cron job status filter." },
        enabled: { type: "boolean", description: "Optional enabled-state filter." },
        limit: { type: "number", description: "Optional maximum number of jobs to return. Defaults to 25." },
      },
    },
    validate: (value: unknown) => cronListJobsArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof cronListJobsArgsSchema>;
      const { agentId, roomContext, targetRoomIds } = getCronScope(context);
      if (args.targetRoomId) {
        getAttachedRoom(roomContext, args.targetRoomId);
      }
      const jobs = await listCronJobs({
        agentId,
        targetRoomIds,
        roomId: args.targetRoomId,
        status: args.status,
        enabled: args.enabled,
        limit: args.limit,
      });
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      return createStructuredOutput({
        totalCount: jobs.length,
        jobs: jobs.map((job) => formatCronJobOutput(job, roomTitleById)),
      });
    },
  } satisfies ToolDefinition<unknown>,
  get_cron_job: {
    name: "get_cron_job",
    displayName: "Get Cron Job",
    description:
      "Read one scheduled task owned by the current agent, plus optional recent run history, as long as the target room is attached to the current agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: { type: "string", description: "The cron job id to inspect." },
        includeRuns: { type: "boolean", description: "Whether to include recent runs. Defaults to true." },
        runLimit: { type: "number", description: "How many recent runs to include when includeRuns is true. Defaults to 5." },
      },
      required: ["jobId"],
    },
    validate: (value: unknown) => cronGetJobArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof cronGetJobArgsSchema>;
      const { agentId, roomContext, targetRoomIds } = getCronScope(context);
      const details = await getCronJobDetails(args.jobId, {
        agentId,
        targetRoomIds,
        runLimit: args.includeRuns ? args.runLimit : 1,
      });
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      const jobTitleById = new Map([[details.job.id, details.job.title]]);
      return createStructuredOutput({
        job: formatCronJobOutput(details.job, roomTitleById),
        recentRuns: args.includeRuns ? details.runs.map((run) => formatCronRunOutput(run, roomTitleById, jobTitleById)) : [],
      });
    },
  } satisfies ToolDefinition<unknown>,
  create_cron_job: {
    name: "create_cron_job",
    displayName: "Create Cron Job",
    description:
      "Create a scheduled task for the current agent in the current room or another attached room. The current agent is always the executor; you cannot create cron jobs for a different agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        targetRoomId: { type: "string", description: "Optional attached room id. Defaults to the current room." },
        title: { type: "string", description: "Human-readable cron job title." },
        prompt: { type: "string", description: "Operator instruction that should run when the cron job triggers." },
        scheduleType: { type: "string", enum: ["once", "daily", "weekly"], description: "The schedule type." },
        onceAt: { type: "string", description: "Required when scheduleType=once. Use an ISO timestamp or a datetime string the server can parse." },
        time: { type: "string", description: "Required when scheduleType is daily or weekly. Use HH:mm." },
        dayOfWeek: { type: "number", description: "Required when scheduleType=weekly. 0=Sunday through 6=Saturday." },
        deliveryPolicy: { type: "string", enum: ["silent", "only_on_result", "always_post_summary"], description: "How the run may emit visible room messages." },
        enabled: { type: "boolean", description: "Whether the job starts enabled. Defaults to true." },
      },
      required: ["title", "prompt", "scheduleType"],
    },
    validate: (value: unknown) => cronCreateArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof cronCreateArgsSchema>;
      const { agentId, roomContext, targetRoomIds } = getCronScope(context);
      const targetRoomId = resolveCronTargetRoomId(roomContext, args.targetRoomId);
      const schedule = buildCronSchedule(args);
      const job = await createManagedCronJob(
        {
          agentId,
          targetRoomId,
          title: args.title,
          prompt: args.prompt,
          schedule,
          deliveryPolicy: args.deliveryPolicy,
          enabled: args.enabled,
        },
        {
          agentId,
          targetRoomIds,
        },
      );
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      return createStructuredOutput({
        created: true,
        job: formatCronJobOutput(job, roomTitleById),
        schedulePreview: previewCronSchedule(schedule),
      });
    },
  } satisfies ToolDefinition<unknown>,
  update_cron_job: {
    name: "update_cron_job",
    displayName: "Update Cron Job",
    description:
      "Update a scheduled task owned by the current agent. To change schedule fields, provide scheduleType together with the fields required for that schedule shape.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: { type: "string", description: "The cron job id to update." },
        targetRoomId: { type: "string", description: "Optional attached room id to move the job to." },
        title: { type: "string", description: "Optional new title." },
        prompt: { type: "string", description: "Optional new prompt." },
        scheduleType: { type: "string", enum: ["once", "daily", "weekly"], description: "Required when updating schedule fields." },
        onceAt: { type: "string", description: "Required when scheduleType=once." },
        time: { type: "string", description: "Required when scheduleType is daily or weekly. Use HH:mm." },
        dayOfWeek: { type: "number", description: "Required when scheduleType=weekly. 0=Sunday through 6=Saturday." },
        deliveryPolicy: { type: "string", enum: ["silent", "only_on_result", "always_post_summary"], description: "Optional new delivery policy." },
        enabled: { type: "boolean", description: "Optional enabled-state update." },
      },
      required: ["jobId"],
    },
    validate: (value: unknown) => cronUpdateArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof cronUpdateArgsSchema>;
      const { agentId, roomContext, targetRoomIds } = getCronScope(context);
      const patch = {
        ...(args.targetRoomId ? { targetRoomId: resolveCronTargetRoomId(roomContext, args.targetRoomId) } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.prompt ? { prompt: args.prompt } : {}),
        ...(typeof args.deliveryPolicy !== "undefined" ? { deliveryPolicy: args.deliveryPolicy } : {}),
        ...(typeof args.enabled !== "undefined" ? { enabled: args.enabled } : {}),
        ...(args.scheduleType
          ? {
              schedule: buildCronSchedule({
                scheduleType: args.scheduleType,
                onceAt: args.onceAt,
                time: args.time,
                dayOfWeek: args.dayOfWeek,
              }),
            }
          : {}),
      };
      const job = await updateManagedCronJob(args.jobId, patch, {
        agentId,
        targetRoomIds,
      });
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      return createStructuredOutput({
        updated: true,
        job: formatCronJobOutput(job, roomTitleById),
      });
    },
  } satisfies ToolDefinition<unknown>,
  pause_cron_job: {
    name: "pause_cron_job",
    displayName: "Pause Cron Job",
    description: "Disable one scheduled task owned by the current agent without deleting it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { jobId: { type: "string", description: "The cron job id to pause." } },
      required: ["jobId"],
    },
    validate: (value: unknown) => cronJobActionArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof cronJobActionArgsSchema>;
      const { agentId, roomContext, targetRoomIds } = getCronScope(context);
      const job = await pauseManagedCronJob(args.jobId, { agentId, targetRoomIds });
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      return createStructuredOutput({ paused: true, job: formatCronJobOutput(job, roomTitleById) });
    },
  } satisfies ToolDefinition<unknown>,
  resume_cron_job: {
    name: "resume_cron_job",
    displayName: "Resume Cron Job",
    description: "Re-enable one paused scheduled task owned by the current agent and recompute its next run time.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { jobId: { type: "string", description: "The cron job id to resume." } },
      required: ["jobId"],
    },
    validate: (value: unknown) => cronJobActionArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof cronJobActionArgsSchema>;
      const { agentId, roomContext, targetRoomIds } = getCronScope(context);
      const job = await resumeManagedCronJob(args.jobId, { agentId, targetRoomIds });
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      return createStructuredOutput({ resumed: true, job: formatCronJobOutput(job, roomTitleById) });
    },
  } satisfies ToolDefinition<unknown>,
  delete_cron_job: {
    name: "delete_cron_job",
    displayName: "Delete Cron Job",
    description: "Delete one scheduled task owned by the current agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { jobId: { type: "string", description: "The cron job id to delete." } },
      required: ["jobId"],
    },
    validate: (value: unknown) => cronJobActionArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof cronJobActionArgsSchema>;
      const { agentId, roomContext, targetRoomIds } = getCronScope(context);
      const details = await getCronJobDetails(args.jobId, { agentId, targetRoomIds, runLimit: 1 });
      await deleteManagedCronJob(args.jobId, { agentId, targetRoomIds });
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      return createStructuredOutput({ deleted: true, job: formatCronJobOutput(details.job, roomTitleById) });
    },
  } satisfies ToolDefinition<unknown>,
  run_cron_job_now: {
    name: "run_cron_job_now",
    displayName: "Run Cron Job Now",
    description: "Queue one scheduled task owned by the current agent for immediate execution without changing its future schedule.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { jobId: { type: "string", description: "The cron job id to queue immediately." } },
      required: ["jobId"],
    },
    validate: (value: unknown) => cronJobActionArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof cronJobActionArgsSchema>;
      const { agentId, roomContext, targetRoomIds } = getCronScope(context);
      const job = await runManagedCronJobNow(args.jobId, { agentId, targetRoomIds });
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      return createStructuredOutput({ queuedNow: true, job: formatCronJobOutput(job, roomTitleById) });
    },
  } satisfies ToolDefinition<unknown>,
  list_cron_runs: {
    name: "list_cron_runs",
    displayName: "List Cron Runs",
    description:
      "List recent execution records for scheduled tasks owned by the current agent across attached rooms. You can filter by jobId, targetRoomId, status, and limit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: { type: "string", description: "Optional cron job id filter." },
        targetRoomId: { type: "string", description: "Optional attached room id filter." },
        status: { type: "string", enum: ["running", "completed", "failed"], description: "Optional run status filter." },
        limit: { type: "number", description: "Optional maximum number of run records to return. Defaults to 10." },
      },
    },
    validate: (value: unknown) => cronListRunsArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof cronListRunsArgsSchema>;
      const { agentId, roomContext, targetRoomIds } = getCronScope(context);
      if (args.targetRoomId) {
        getAttachedRoom(roomContext, args.targetRoomId);
      }
      const runs = await listCronRuns({
        agentId,
        targetRoomIds,
        jobId: args.jobId,
        roomId: args.targetRoomId,
        status: args.status,
        limit: args.limit,
      });
      const jobs = await listCronJobs({ agentId, targetRoomIds });
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      const jobTitleById = new Map(jobs.map((job) => [job.id, job.title]));
      return createStructuredOutput({
        totalCount: runs.length,
        runs: runs.map((run) => formatCronRunOutput(run, roomTitleById, jobTitleById)),
      });
    },
  } satisfies ToolDefinition<unknown>,
  preview_cron_schedule: {
    name: "preview_cron_schedule",
    displayName: "Preview Cron Schedule",
    description: "Preview how a proposed schedule will be interpreted, including the next and following trigger times.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scheduleType: { type: "string", enum: ["once", "daily", "weekly"], description: "The schedule type to preview." },
        onceAt: { type: "string", description: "Required when scheduleType=once." },
        time: { type: "string", description: "Required when scheduleType is daily or weekly. Use HH:mm." },
        dayOfWeek: { type: "number", description: "Required when scheduleType=weekly. 0=Sunday through 6=Saturday." },
      },
      required: ["scheduleType"],
    },
    validate: (value: unknown) => cronPreviewArgsSchema.parse(value),
    execute: async (value: unknown) => {
      const args = value as z.infer<typeof cronPreviewArgsSchema>;
      const schedule = buildCronSchedule(args);
      return createStructuredOutput(previewCronSchedule(schedule));
    },
  } satisfies ToolDefinition<unknown>,
};
