import { z } from "zod";
import { CUSTOM_COMMAND_NAME_TUPLE, CUSTOM_COMMAND_NAMES } from "./custom-commands";
import { previewCronSchedule } from "@/lib/server/cron-service";
import type {
  AgentInfoCard,
  AttachedRoomDefinition,
  RoomCronJob,
  RoomCronRunRecord,
  RoomCronSchedule,
  RoomAgentId,
  RoomHistoryMessageSummary,
  RoomManagementToolAction,
  RoomMessageEmission,
  RoomToolActionUnion,
  RoomToolContext,
} from "@/lib/chat/types";
import { safeJsonStringify } from "@/lib/shared/text";
import { createUuid } from "@/lib/utils/uuid";

export type ToolName =
  | "bash"
  | "web_fetch"
  | "custom_command"
  | "send_message_to_room"
  | "read_no_reply"
  | "list_attached_rooms"
  | "list_known_agents"
  | "create_room"
  | "add_agents_to_room"
  | "leave_room"
  | "remove_room_participant"
  | "get_room_history"
  | "list_cron_jobs"
  | "get_cron_job"
  | "create_cron_job"
  | "update_cron_job"
  | "pause_cron_job"
  | "resume_cron_job"
  | "delete_cron_job"
  | "run_cron_job_now"
  | "list_cron_runs"
  | "preview_cron_schedule"
  | "memory_search"
  | "memory_get"
  | "workspace_list"
  | "workspace_read"
  | "workspace_write"
  | "workspace_delete"
  | "workspace_append"
  | "workspace_move"
  | "workspace_mkdir"
  | "shared_workspace_list"
  | "shared_workspace_read"
  | "shared_workspace_write"
  | "shared_workspace_delete"
  | "shared_workspace_append"
  | "shared_workspace_move"
  | "shared_workspace_mkdir";

export interface ToolExecutionContext {
  room?: RoomToolContext;
}

export interface ToolRuntimeResult {
  output: string;
  roomMessage?: RoomMessageEmission;
  roomAction?: RoomToolActionUnion;
}

export interface ToolDefinition<TInput> {
  name: ToolName;
  displayName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  validate: (value: unknown) => TInput;
  execute: (value: TInput, signal?: AbortSignal, context?: ToolExecutionContext) => Promise<string | ToolRuntimeResult>;
}

export const optionalTrimmedString = (maxLength: number) =>
  z.preprocess(
    (value) => {
      if (typeof value !== "string") {
        return value;
      }

      const trimmed = value.trim();
      return trimmed ? trimmed : undefined;
    },
    z.string().max(maxLength).optional(),
  );

export const optionalUrlString = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  },
  z.string().url().optional(),
);

export const emptyArgsSchema = z.object({}).strict();
export const roomAgentIdSchema = z.string().trim().min(1).max(120);

export const webFetchArgsSchema = z.object({
  url: z.string().url(),
  focus: optionalTrimmedString(200),
});

export const bashArgsSchema = z
  .object({
    command: z.string().trim().min(1).max(20_000),
    cwd: optionalTrimmedString(1_000),
    timeoutMs: z.number().int().min(1_000).max(10 * 60 * 1_000).optional().default(120_000),
  })
  .strict();

export const customCommandArgsSchema = z.object({
  command: z.enum(CUSTOM_COMMAND_NAME_TUPLE),
  url: optionalUrlString,
  timezone: optionalTrimmedString(120),
  topic: optionalTrimmedString(200),
});

export const roomMessageArgsSchema = z.object({
  roomId: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(4_000),
  kind: z.enum(["answer", "progress", "warning", "error", "clarification"]).optional().default("answer"),
  status: z.enum(["pending", "streaming", "completed", "failed"]).optional().default("completed"),
  final: z.boolean().optional().default(true),
});

export const readNoReplyArgsSchema = z
  .object({
    roomId: z.string().trim().min(1).max(120),
    messageId: z.string().trim().min(1).max(120),
  })
  .strict();

export const createRoomArgsSchema = z
  .object({
    title: optionalTrimmedString(120),
    agentIds: z.array(roomAgentIdSchema).max(12).optional().default([]),
  })
  .strict();

export const addAgentsToRoomArgsSchema = z
  .object({
    roomId: z.string().trim().min(1).max(120),
    agentIds: z.array(roomAgentIdSchema).min(1).max(12),
  })
  .strict();

export const leaveRoomArgsSchema = z
  .object({
    roomId: z.string().trim().min(1).max(120),
  })
  .strict();

export const removeRoomParticipantArgsSchema = z
  .object({
    roomId: z.string().trim().min(1).max(120),
    participantId: z.string().trim().min(1).max(120),
  })
  .strict();

export const getRoomHistoryArgsSchema = z
  .object({
    roomId: z.string().trim().min(1).max(120),
    limit: z.number().int().min(1).max(100).optional().default(10),
  })
  .strict();

export const memorySearchArgsSchema = z
  .object({
    query: z.string().trim().min(1).max(300),
    maxResults: z.number().int().min(1).max(20).optional().default(8),
    minScore: z.number().min(0).max(100).optional().default(1),
  })
  .strict();

export const memoryGetArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(200),
    from: z.number().int().min(1).optional(),
    lines: z.number().int().min(1).max(200).optional().default(40),
  })
  .strict();

export const workspaceListArgsSchema = z
  .object({
    path: optionalTrimmedString(240),
    recursive: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(500).optional().default(200),
  })
  .strict();

export const workspaceReadArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(240),
    fromLine: z.number().int().min(1).optional(),
    lineCount: z.number().int().min(1).max(400).optional().default(200),
  })
  .strict();

export const workspaceWriteArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(240),
    content: z.string().max(200_000),
  })
  .strict();

export const workspaceDeleteArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(240),
    recursive: z.boolean().optional().default(false),
  })
  .strict();

export const workspaceAppendArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(240),
    content: z.string().max(200_000),
  })
  .strict();

export const workspaceMoveArgsSchema = z
  .object({
    fromPath: z.string().trim().min(1).max(240),
    toPath: z.string().trim().min(1).max(240),
  })
  .strict();

export const workspaceMkdirArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(240),
    recursive: z.boolean().optional().default(true),
  })
  .strict();

export const cronScheduleTypeSchema = z.enum(["once", "daily", "weekly"]);
export const cronDeliveryPolicySchema = z.enum(["silent", "only_on_result", "always_post_summary"]);
export const cronJobStatusSchema = z.enum(["idle", "queued", "running", "error"]);
export const cronRunStatusSchema = z.enum(["running", "completed", "failed"]);

export const cronCreateArgsSchema = z
  .object({
    targetRoomId: optionalTrimmedString(120),
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(4_000),
    scheduleType: cronScheduleTypeSchema,
    onceAt: optionalTrimmedString(120),
    time: optionalTrimmedString(5),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    deliveryPolicy: cronDeliveryPolicySchema.optional().default("only_on_result"),
    enabled: z.boolean().optional().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scheduleType === "once" && !value.onceAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["onceAt"], message: "onceAt is required for once schedules." });
    }
    if ((value.scheduleType === "daily" || value.scheduleType === "weekly") && !value.time) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["time"], message: "time is required for daily and weekly schedules." });
    }
    if (value.scheduleType === "weekly" && typeof value.dayOfWeek !== "number") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dayOfWeek"], message: "dayOfWeek is required for weekly schedules." });
    }
  });

export const cronUpdateArgsSchema = z
  .object({
    jobId: z.string().trim().min(1).max(120),
    targetRoomId: optionalTrimmedString(120),
    title: optionalTrimmedString(120),
    prompt: optionalTrimmedString(4_000),
    scheduleType: cronScheduleTypeSchema.optional(),
    onceAt: optionalTrimmedString(120),
    time: optionalTrimmedString(5),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    deliveryPolicy: cronDeliveryPolicySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasScheduleField = typeof value.scheduleType !== "undefined" || typeof value.onceAt !== "undefined" || typeof value.time !== "undefined" || typeof value.dayOfWeek !== "undefined";
    if (
      !hasScheduleField
      && typeof value.targetRoomId === "undefined"
      && typeof value.title === "undefined"
      && typeof value.prompt === "undefined"
      && typeof value.deliveryPolicy === "undefined"
      && typeof value.enabled === "undefined"
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide at least one field to update." });
    }
    if (hasScheduleField && !value.scheduleType) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scheduleType"], message: "scheduleType is required when updating schedule fields." });
    }
    if (value.scheduleType === "once" && !value.onceAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["onceAt"], message: "onceAt is required for once schedules." });
    }
    if ((value.scheduleType === "daily" || value.scheduleType === "weekly") && !value.time) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["time"], message: "time is required for daily and weekly schedules." });
    }
    if (value.scheduleType === "weekly" && typeof value.dayOfWeek !== "number") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dayOfWeek"], message: "dayOfWeek is required for weekly schedules." });
    }
  });

export const cronListJobsArgsSchema = z
  .object({
    targetRoomId: optionalTrimmedString(120),
    status: cronJobStatusSchema.optional(),
    enabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

export const cronGetJobArgsSchema = z
  .object({
    jobId: z.string().trim().min(1).max(120),
    includeRuns: z.boolean().optional().default(true),
    runLimit: z.number().int().min(1).max(50).optional().default(5),
  })
  .strict();

export const cronJobActionArgsSchema = z
  .object({
    jobId: z.string().trim().min(1).max(120),
  })
  .strict();

export const cronListRunsArgsSchema = z
  .object({
    jobId: optionalTrimmedString(120),
    targetRoomId: optionalTrimmedString(120),
    status: cronRunStatusSchema.optional(),
    limit: z.number().int().min(1).max(100).optional().default(10),
  })
  .strict();

export const cronPreviewArgsSchema = z
  .object({
    scheduleType: cronScheduleTypeSchema,
    onceAt: optionalTrimmedString(120),
    time: optionalTrimmedString(5),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scheduleType === "once" && !value.onceAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["onceAt"], message: "onceAt is required for once schedules." });
    }
    if ((value.scheduleType === "daily" || value.scheduleType === "weekly") && !value.time) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["time"], message: "time is required for daily and weekly schedules." });
    }
    if (value.scheduleType === "weekly" && typeof value.dayOfWeek !== "number") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dayOfWeek"], message: "dayOfWeek is required for weekly schedules." });
    }
  });

export function getRoomToolContext(context?: ToolExecutionContext): RoomToolContext {
  if (!context?.room) {
    throw new Error("This tool requires room context, but no room context was supplied.");
  }

  return context.room;
}

export function getCurrentAgentId(context?: ToolExecutionContext): RoomAgentId {
  const roomContext = getRoomToolContext(context);
  if (!roomContext.currentAgentId) {
    throw new Error("The current agent id is missing from the room context.");
  }

  return roomContext.currentAgentId;
}

export function uniqueAgentIds(agentIds: RoomAgentId[]): RoomAgentId[] {
  return [...new Set(agentIds)];
}

export function findKnownAgent(context: RoomToolContext, agentId: RoomAgentId): AgentInfoCard | undefined {
  return context.knownAgents.find((agent) => agent.agentId === agentId);
}

export function getKnownAgent(context: RoomToolContext, agentId: RoomAgentId): AgentInfoCard {
  const agent = findKnownAgent(context, agentId);
  if (!agent) {
    throw new Error(`Unknown agent id: ${agentId}`);
  }

  return agent;
}

export function findAttachedRoom(context: RoomToolContext, roomId: string): AttachedRoomDefinition | undefined {
  return context.attachedRooms.find((room) => room.id === roomId);
}

export function getAttachedRoom(context: RoomToolContext, roomId: string): AttachedRoomDefinition {
  const room = findAttachedRoom(context, roomId);
  if (!room) {
    throw new Error(`Room ${roomId} is not attached to the current agent.`);
  }

  return room;
}

export function assertWritableRoom(room: AttachedRoomDefinition): void {
  if (room.archived) {
    throw new Error(`Room ${room.id} is archived and cannot be modified.`);
  }
}

export function assertRoomOwner(context: RoomToolContext, room: AttachedRoomDefinition): void {
  if (!context.currentAgentId) {
    throw new Error("The current agent id is missing from the room context.");
  }

  if (room.ownerParticipantId !== context.currentAgentId) {
    throw new Error(`Only the room owner can modify membership in room ${room.id}.`);
  }
}

export function buildCronSchedule(args: {
  scheduleType: z.infer<typeof cronScheduleTypeSchema>;
  onceAt?: string;
  time?: string;
  dayOfWeek?: number;
}): RoomCronSchedule {
  if (args.scheduleType === "once") {
    return {
      type: "once",
      at: new Date(args.onceAt as string).toISOString(),
    };
  }
  if (args.scheduleType === "daily") {
    return {
      type: "daily",
      time: args.time as string,
    };
  }
  return {
    type: "weekly",
    dayOfWeek: args.dayOfWeek as number,
    time: args.time as string,
  };
}

export function getCronScope(context?: ToolExecutionContext): { agentId: RoomAgentId; roomContext: RoomToolContext; targetRoomIds: string[] } {
  const roomContext = getRoomToolContext(context);
  return {
    agentId: getCurrentAgentId(context),
    roomContext,
    targetRoomIds: roomContext.attachedRooms.map((room) => room.id),
  };
}

export function resolveCronTargetRoomId(roomContext: RoomToolContext, targetRoomId?: string): string {
  const resolvedRoomId = targetRoomId ?? roomContext.currentRoomId;
  if (!resolvedRoomId) {
    throw new Error("No target roomId was provided and there is no current room in context.");
  }
  const room = getAttachedRoom(roomContext, resolvedRoomId);
  assertWritableRoom(room);
  return room.id;
}

export function buildCronRoomTitleMap(roomContext: RoomToolContext): Map<string, string> {
  return new Map(roomContext.attachedRooms.map((room) => [room.id, room.title]));
}

export function formatCronJobOutput(job: RoomCronJob, roomTitleById: Map<string, string>) {
  return {
    jobId: job.id,
    agentId: job.agentId,
    targetRoomId: job.targetRoomId,
    targetRoomTitle: roomTitleById.get(job.targetRoomId) ?? null,
    title: job.title,
    prompt: job.prompt,
    schedule: job.schedule,
    scheduleDescription: previewCronSchedule(job.schedule).description,
    deliveryPolicy: job.deliveryPolicy,
    enabled: job.enabled,
    status: job.status,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt,
    lastError: job.lastError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function formatCronRunOutput(run: RoomCronRunRecord, roomTitleById: Map<string, string>, jobTitleById: Map<string, string>) {
  return {
    runId: run.id,
    jobId: run.jobId,
    jobTitle: jobTitleById.get(run.jobId) ?? null,
    agentId: run.agentId,
    targetRoomId: run.targetRoomId,
    targetRoomTitle: roomTitleById.get(run.targetRoomId) ?? null,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    summary: run.summary,
    error: run.error,
  };
}

export function formatJsonOutput(value: unknown): string {
  return safeJsonStringify(value);
}

export function createRoomMessageResult(args: z.infer<typeof roomMessageArgsSchema>): ToolRuntimeResult {
  return {
    output: `Sent a room message (${args.kind}/${args.status}/${args.final ? "final" : "non-final"}).`,
    roomMessage: {
      roomId: args.roomId,
      content: args.content,
      kind: args.kind,
      status: args.status,
      final: args.final,
    },
  } satisfies ToolRuntimeResult;
}

export function buildAutoRoomTitle(agentIds: RoomAgentId[], context: RoomToolContext): string {
  return uniqueAgentIds(agentIds)
    .map((agentId) => getKnownAgent(context, agentId).label)
    .join(" + ");
}

export function getRoomOwnerName(room: AttachedRoomDefinition): string | null {
  if (room.ownerName) {
    return room.ownerName;
  }

  return room.participants.find((participant) => participant.membershipRole === "owner")?.name ?? null;
}

function getCurrentAgentMembershipRole(room: AttachedRoomDefinition, currentAgentId?: RoomAgentId) {
  if (!currentAgentId) {
    return null;
  }

  return room.participants.find((participant) => participant.participantId === currentAgentId)?.membershipRole ?? null;
}

function syncCurrentAgentRoomFlags(room: AttachedRoomDefinition, currentAgentId?: RoomAgentId): AttachedRoomDefinition {
  const currentAgentMembershipRole = getCurrentAgentMembershipRole(room, currentAgentId);
  room.currentAgentMembershipRole = currentAgentMembershipRole;
  room.currentAgentIsOwner = currentAgentMembershipRole === "owner";
  return room;
}

export function createAgentParticipantSnapshot(context: RoomToolContext, agentId: RoomAgentId, membershipRole: "owner" | "member") {
  const agent = getKnownAgent(context, agentId);
  return {
    participantId: agentId,
    name: agent.label,
    runtimeKind: "agent" as const,
    membershipRole,
    enabled: true,
    agentId,
  };
}

export function mutateCreateRoomContext(context: RoomToolContext, action: Extract<RoomManagementToolAction, { type: "create_room" }>) {
  const ownerName = context.currentAgentId ? getKnownAgent(context, context.currentAgentId).label : null;
  const participants = action.agentIds.map((agentId) =>
    createAgentParticipantSnapshot(context, agentId, context.currentAgentId === agentId ? "owner" : "member"),
  );

  const currentAgentMembershipRole = context.currentAgentId ? "owner" : null;

  context.attachedRooms = [
    ...context.attachedRooms,
    {
      id: action.roomId,
      title: action.title,
      archived: false,
      ownerParticipantId: context.currentAgentId ?? null,
      ownerName,
      currentAgentMembershipRole,
      currentAgentIsOwner: currentAgentMembershipRole === "owner",
      participants,
      messageCount: 0,
      latestMessageAt: null,
    },
  ];
  context.roomHistoryById[action.roomId] = [];
}

export function mutateAddAgentsContext(
  context: RoomToolContext,
  action: Extract<RoomManagementToolAction, { type: "add_agents_to_room" }>,
): AttachedRoomDefinition {
  const room = getAttachedRoom(context, action.roomId);
  const existingAgentIds = new Set(room.participants.flatMap((participant) => (participant.agentId ? [participant.agentId] : [])));
  const nextParticipants = [...room.participants];

  for (const agentId of action.agentIds) {
    if (existingAgentIds.has(agentId)) {
      continue;
    }

    nextParticipants.push(createAgentParticipantSnapshot(context, agentId, "member"));
    existingAgentIds.add(agentId);
  }

  room.participants = nextParticipants;
  return syncCurrentAgentRoomFlags(room, context.currentAgentId);
}

export function mutateLeaveRoomContext(
  context: RoomToolContext,
  action: Extract<RoomManagementToolAction, { type: "leave_room" }>,
): void {
  context.attachedRooms = context.attachedRooms.filter((room) => room.id !== action.roomId);
  delete context.roomHistoryById[action.roomId];
}

export function mutateRemoveParticipantContext(
  context: RoomToolContext,
  action: Extract<RoomManagementToolAction, { type: "remove_room_participant" }>,
): AttachedRoomDefinition {
  const room = getAttachedRoom(context, action.roomId);
  room.participants = room.participants.filter((participant) => participant.participantId !== action.participantId);
  if (!room.participants.some((participant) => participant.participantId === room.ownerParticipantId)) {
    const nextOwner = room.participants[0] ?? null;
    room.ownerParticipantId = nextOwner?.participantId ?? null;
    room.ownerName = nextOwner?.name ?? null;
    room.participants = room.participants.map((participant) => ({
      ...participant,
      membershipRole: nextOwner && participant.participantId === nextOwner.participantId ? "owner" : "member",
    }));
  }
  return syncCurrentAgentRoomFlags(room, context.currentAgentId);
}

export function createStructuredOutput(output: unknown, roomAction?: RoomToolActionUnion): ToolRuntimeResult {
  return {
    output: formatJsonOutput(output),
    ...(roomAction ? { roomAction } : {}),
  };
}

export function appendVisibleHistoryMessage(
  context: RoomToolContext,
  roomId: string,
  message: Omit<RoomHistoryMessageSummary, "messageId" | "seq" | "createdAt" | "receipts"> & {
    receipts?: RoomHistoryMessageSummary["receipts"];
  },
): void {
  const room = findAttachedRoom(context, roomId);
  if (!room) {
    return;
  }

  const createdAt = new Date().toISOString();
  const currentHistory = context.roomHistoryById[roomId] ?? [];
  const nextMessage: RoomHistoryMessageSummary = {
    messageId: createUuid(),
    seq: (currentHistory[currentHistory.length - 1]?.seq ?? 0) + 1,
    createdAt,
    receipts: message.receipts ? [...message.receipts] : [],
    ...message,
  };

  context.roomHistoryById[roomId] = [...currentHistory, nextMessage];
  room.messageCount = context.roomHistoryById[roomId].length;
  room.latestMessageAt = createdAt;
}

export function applyReadNoReplyToHistory(context: RoomToolContext, roomId: string, messageId: string): void {
  const history = context.roomHistoryById[roomId];
  const room = findAttachedRoom(context, roomId);
  const currentAgentId = context.currentAgentId;
  if (!history || !room || !currentAgentId) {
    return;
  }

  const currentAgent = findKnownAgent(context, currentAgentId);
  if (!currentAgent) {
    return;
  }

  context.roomHistoryById[roomId] = history.map((message) =>
    message.messageId === messageId && !message.receipts.some((receipt) => receipt.participantId === currentAgentId)
      ? {
          ...message,
          receipts: [
            ...message.receipts,
            {
              participantId: currentAgentId,
              participantName: currentAgent.label,
              agentId: currentAgentId,
              type: "read_no_reply",
              createdAt: new Date().toISOString(),
            },
          ],
        }
      : message,
  );
}

export function createToolMaps<T extends ToolName>(definitions: Record<T, ToolDefinition<unknown>>) {
  return definitions;
}

export { CUSTOM_COMMAND_NAMES };
