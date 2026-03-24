import { z } from "zod";
import { CUSTOM_COMMAND_NAME_TUPLE, CUSTOM_COMMAND_NAMES, executeCustomCommand } from "./custom-commands";
import { fetchWebPage } from "./web-fetch";
import {
  appendAgentWorkspaceFile,
  appendSharedWorkspaceFile,
  deleteAgentWorkspaceEntry,
  deleteSharedWorkspaceEntry,
  listAgentWorkspace,
  listSharedWorkspace,
  mkdirAgentWorkspace,
  mkdirSharedWorkspace,
  moveAgentWorkspaceEntry,
  moveSharedWorkspaceEntry,
  readAgentWorkspaceFile,
  readSharedWorkspaceFile,
  writeAgentWorkspaceFile,
  writeSharedWorkspaceFile,
} from "@/lib/server/agent-workspace-store";
import { readAgentMemoryFile, searchAgentMemory } from "@/lib/server/agent-memory-store";
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
  RoomToolAction,
  RoomToolActionUnion,
  RoomToolContext,
  ToolExecution,
  ToolScope,
} from "@/lib/chat/types";
import { safeJsonStringify, truncateText } from "@/lib/shared/text";

type ToolName =
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

interface ToolExecutionContext {
  room?: RoomToolContext;
}

interface ToolRuntimeResult {
  output: string;
  roomMessage?: RoomMessageEmission;
  roomAction?: RoomToolActionUnion;
}

interface ToolDefinition<TInput> {
  name: ToolName;
  displayName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  validate: (value: unknown) => TInput;
  execute: (value: TInput, signal?: AbortSignal, context?: ToolExecutionContext) => Promise<string | ToolRuntimeResult>;
}

const optionalTrimmedString = (maxLength: number) =>
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

const optionalUrlString = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  },
  z.string().url().optional(),
);

const emptyArgsSchema = z.object({}).strict();

const roomAgentIdSchema = z.enum(["concierge", "researcher", "operator"]);

const webFetchArgsSchema = z.object({
  url: z.string().url(),
  focus: optionalTrimmedString(200),
});

const customCommandArgsSchema = z.object({
  command: z.enum(CUSTOM_COMMAND_NAME_TUPLE),
  url: optionalUrlString,
  timezone: optionalTrimmedString(120),
  topic: optionalTrimmedString(200),
});

const roomMessageArgsSchema = z.object({
  roomId: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(4_000),
  kind: z.enum(["answer", "progress", "warning", "error", "clarification"]).optional().default("answer"),
  status: z.enum(["pending", "streaming", "completed", "failed"]).optional().default("completed"),
  final: z.boolean().optional().default(true),
});

const readNoReplyArgsSchema = z
  .object({
    roomId: z.string().trim().min(1).max(120),
    messageId: z.string().trim().min(1).max(120),
  })
  .strict();

const createRoomArgsSchema = z
  .object({
    title: optionalTrimmedString(120),
    agentIds: z.array(roomAgentIdSchema).max(12).optional().default([]),
  })
  .strict();

const addAgentsToRoomArgsSchema = z
  .object({
    roomId: z.string().trim().min(1).max(120),
    agentIds: z.array(roomAgentIdSchema).min(1).max(12),
  })
  .strict();

const leaveRoomArgsSchema = z
  .object({
    roomId: z.string().trim().min(1).max(120),
  })
  .strict();

const removeRoomParticipantArgsSchema = z
  .object({
    roomId: z.string().trim().min(1).max(120),
    participantId: z.string().trim().min(1).max(120),
  })
  .strict();

const getRoomHistoryArgsSchema = z
  .object({
    roomId: z.string().trim().min(1).max(120),
    limit: z.number().int().min(1).max(100).optional().default(10),
  })
  .strict();

const memorySearchArgsSchema = z
  .object({
    query: z.string().trim().min(1).max(300),
    maxResults: z.number().int().min(1).max(20).optional().default(8),
    minScore: z.number().min(0).max(100).optional().default(1),
  })
  .strict();

const memoryGetArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(200),
    from: z.number().int().min(1).optional(),
    lines: z.number().int().min(1).max(200).optional().default(40),
  })
  .strict();

const workspaceListArgsSchema = z
  .object({
    path: optionalTrimmedString(240),
    recursive: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(500).optional().default(200),
  })
  .strict();

const workspaceReadArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(240),
    fromLine: z.number().int().min(1).optional(),
    lineCount: z.number().int().min(1).max(400).optional().default(200),
  })
  .strict();

const workspaceWriteArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(240),
    content: z.string().max(200_000),
  })
  .strict();

const workspaceDeleteArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(240),
    recursive: z.boolean().optional().default(false),
  })
  .strict();

const workspaceAppendArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(240),
    content: z.string().max(200_000),
  })
  .strict();

const workspaceMoveArgsSchema = z
  .object({
    fromPath: z.string().trim().min(1).max(240),
    toPath: z.string().trim().min(1).max(240),
  })
  .strict();

const workspaceMkdirArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(240),
    recursive: z.boolean().optional().default(true),
  })
  .strict();

const cronScheduleTypeSchema = z.enum(["once", "daily", "weekly"]);
const cronDeliveryPolicySchema = z.enum(["silent", "only_on_result", "always_post_summary"]);
const cronJobStatusSchema = z.enum(["idle", "queued", "running", "error"]);
const cronRunStatusSchema = z.enum(["running", "completed", "failed"]);

const cronCreateArgsSchema = z
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

const cronUpdateArgsSchema = z
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
    if (!hasScheduleField && typeof value.targetRoomId === "undefined" && typeof value.title === "undefined" && typeof value.prompt === "undefined" && typeof value.deliveryPolicy === "undefined" && typeof value.enabled === "undefined") {
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

const cronListJobsArgsSchema = z
  .object({
    targetRoomId: optionalTrimmedString(120),
    status: cronJobStatusSchema.optional(),
    enabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

const cronGetJobArgsSchema = z
  .object({
    jobId: z.string().trim().min(1).max(120),
    includeRuns: z.boolean().optional().default(true),
    runLimit: z.number().int().min(1).max(50).optional().default(5),
  })
  .strict();

const cronJobActionArgsSchema = z
  .object({
    jobId: z.string().trim().min(1).max(120),
  })
  .strict();

const cronListRunsArgsSchema = z
  .object({
    jobId: optionalTrimmedString(120),
    targetRoomId: optionalTrimmedString(120),
    status: cronRunStatusSchema.optional(),
    limit: z.number().int().min(1).max(100).optional().default(10),
  })
  .strict();

const cronPreviewArgsSchema = z
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

function getRoomToolContext(context?: ToolExecutionContext): RoomToolContext {
  if (!context?.room) {
    throw new Error("This tool requires room context, but no room context was supplied.");
  }

  return context.room;
}

function getCurrentAgentId(context?: ToolExecutionContext): RoomAgentId {
  const roomContext = getRoomToolContext(context);
  if (!roomContext.currentAgentId) {
    throw new Error("The current agent id is missing from the room context.");
  }

  return roomContext.currentAgentId;
}

function uniqueAgentIds(agentIds: RoomAgentId[]): RoomAgentId[] {
  return [...new Set(agentIds)];
}

function findKnownAgent(context: RoomToolContext, agentId: RoomAgentId): AgentInfoCard | undefined {
  return context.knownAgents.find((agent) => agent.agentId === agentId);
}

function getKnownAgent(context: RoomToolContext, agentId: RoomAgentId): AgentInfoCard {
  const agent = findKnownAgent(context, agentId);
  if (!agent) {
    throw new Error(`Unknown agent id: ${agentId}`);
  }

  return agent;
}

function findAttachedRoom(context: RoomToolContext, roomId: string): AttachedRoomDefinition | undefined {
  return context.attachedRooms.find((room) => room.id === roomId);
}

function getAttachedRoom(context: RoomToolContext, roomId: string): AttachedRoomDefinition {
  const room = findAttachedRoom(context, roomId);
  if (!room) {
    throw new Error(`Room ${roomId} is not attached to the current agent.`);
  }

  return room;
}

function assertWritableRoom(room: AttachedRoomDefinition): void {
  if (room.archived) {
    throw new Error(`Room ${room.id} is archived and cannot be modified.`);
  }
}

function assertRoomOwner(context: RoomToolContext, room: AttachedRoomDefinition): void {
  if (!context.currentAgentId) {
    throw new Error("The current agent id is missing from the room context.");
  }

  if (room.ownerParticipantId !== context.currentAgentId) {
    throw new Error(`Only the room owner can modify membership in room ${room.id}.`);
  }
}

function buildCronSchedule(args: {
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

function getCronScope(context?: ToolExecutionContext): { agentId: RoomAgentId; roomContext: RoomToolContext; targetRoomIds: string[] } {
  const roomContext = getRoomToolContext(context);
  return {
    agentId: getCurrentAgentId(context),
    roomContext,
    targetRoomIds: roomContext.attachedRooms.map((room) => room.id),
  };
}

function resolveCronTargetRoomId(roomContext: RoomToolContext, targetRoomId?: string): string {
  const resolvedRoomId = targetRoomId ?? roomContext.currentRoomId;
  if (!resolvedRoomId) {
    throw new Error("No target roomId was provided and there is no current room in context.");
  }
  const room = getAttachedRoom(roomContext, resolvedRoomId);
  assertWritableRoom(room);
  return room.id;
}

function buildCronRoomTitleMap(roomContext: RoomToolContext): Map<string, string> {
  return new Map(roomContext.attachedRooms.map((room) => [room.id, room.title]));
}

function formatCronJobOutput(job: RoomCronJob, roomTitleById: Map<string, string>) {
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

function formatCronRunOutput(run: RoomCronRunRecord, roomTitleById: Map<string, string>, jobTitleById: Map<string, string>) {
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

function formatJsonOutput(value: unknown): string {
  return safeJsonStringify(value);
}

function createRoomMessageResult(
  args: z.infer<typeof roomMessageArgsSchema>,
): ToolRuntimeResult {
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

function buildAutoRoomTitle(agentIds: RoomAgentId[], context: RoomToolContext): string {
  return uniqueAgentIds(agentIds)
    .map((agentId) => getKnownAgent(context, agentId).label)
    .join(" + ");
}

function getRoomOwnerName(room: AttachedRoomDefinition): string | null {
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

function createAgentParticipantSnapshot(context: RoomToolContext, agentId: RoomAgentId, membershipRole: "owner" | "member") {
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

function mutateCreateRoomContext(context: RoomToolContext, action: Extract<RoomManagementToolAction, { type: "create_room" }>) {
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

function mutateAddAgentsContext(
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

function mutateLeaveRoomContext(
  context: RoomToolContext,
  action: Extract<RoomManagementToolAction, { type: "leave_room" }>,
): void {
  context.attachedRooms = context.attachedRooms.filter((room) => room.id !== action.roomId);
  delete context.roomHistoryById[action.roomId];
}

function mutateRemoveParticipantContext(
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

function createStructuredOutput(output: unknown, roomAction?: RoomToolActionUnion): ToolRuntimeResult {
  return {
    output: formatJsonOutput(output),
    ...(roomAction
      ? {
          roomAction,
        }
      : {}),
  };
}

function appendVisibleHistoryMessage(
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
    messageId: crypto.randomUUID(),
    seq: (currentHistory[currentHistory.length - 1]?.seq ?? 0) + 1,
    createdAt,
    receipts: message.receipts ? [...message.receipts] : [],
    ...message,
  };

  context.roomHistoryById[roomId] = [...currentHistory, nextMessage];
  room.messageCount = context.roomHistoryById[roomId].length;
  room.latestMessageAt = createdAt;
}

function applyReadNoReplyToHistory(context: RoomToolContext, roomId: string, messageId: string): void {
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

const baseTools: Record<"web_fetch" | "custom_command", ToolDefinition<unknown>> = {
  web_fetch: {
    name: "web_fetch",
    displayName: "Web Fetch",
    description:
      "Fetch a public webpage, remove noisy markup, and return a readable text excerpt. Use this when the user asks about current online content.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description: "The full http or https URL to fetch.",
        },
        focus: {
          type: "string",
          description: "Optional note for what information matters most on the page.",
        },
      },
      required: ["url"],
    },
    validate: (value) => webFetchArgsSchema.parse(value),
    execute: async (value, signal) => {
      const args = value as z.infer<typeof webFetchArgsSchema>;
      return fetchWebPage(args, signal);
    },
  },
  custom_command: {
    name: "custom_command",
    displayName: "Custom Command",
    description:
      "Run one of the registered commands: list_commands, project_profile, current_time, or web_fetch. The web_fetch command also accepts url and optional topic.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          enum: CUSTOM_COMMAND_NAMES,
          description: "Which registered command to run.",
        },
        url: {
          type: "string",
          description: "Required when command is web_fetch.",
        },
        timezone: {
          type: "string",
          description: "Optional IANA timezone when command is current_time.",
        },
        topic: {
          type: "string",
          description: "Optional extra focus or question for the chosen command.",
        },
      },
      required: ["command"],
    },
    validate: (value) => customCommandArgsSchema.parse(value),
    execute: async (value, signal) => {
      const args = value as z.infer<typeof customCommandArgsSchema>;
      return executeCustomCommand(args, signal);
    },
  },
};

const roomOnlyTools: Record<Exclude<ToolName, "web_fetch" | "custom_command">, ToolDefinition<unknown>> = {
  send_message_to_room: {
    name: "send_message_to_room",
    displayName: "Send Message To Room",
    description:
      "Send a structured user-visible message into a specific attached Chat Room. Use this for both direct replies in the current room and relays, notifications, handoffs, or cross-room messaging into another attached room. You must target an attached roomId and use kind, status, and final to describe the delivery.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        roomId: {
          type: "string",
          description: "The target attached Chat Room id that should receive this visible message.",
        },
        content: {
          type: "string",
          description: "The exact message that should be delivered into the target Chat Room.",
        },
        kind: {
          type: "string",
          enum: ["answer", "progress", "warning", "error", "clarification"],
          description: "Semantic message type for the room layer.",
        },
        status: {
          type: "string",
          enum: ["pending", "streaming", "completed", "failed"],
          description: "Delivery or completion state for this room message.",
        },
        final: {
          type: "boolean",
          description: "Whether this visible room message is final for the current turn or subtask.",
        },
      },
      required: ["roomId", "content"],
    },
    validate: (value) => roomMessageArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof roomMessageArgsSchema>;
      const roomContext = getRoomToolContext(context);
      const room = getAttachedRoom(roomContext, args.roomId);
      assertWritableRoom(room);
      if (roomContext.currentAgentId) {
        const currentAgent = getKnownAgent(roomContext, roomContext.currentAgentId);
        appendVisibleHistoryMessage(roomContext, args.roomId, {
          senderId: currentAgent.agentId,
          senderName: currentAgent.label,
          senderRole: "participant",
          role: "assistant",
          source: "agent_emit",
          kind: args.kind,
          status: args.status,
          final: args.final,
          content: args.content,
        });
      }
      return createRoomMessageResult(args);
    },
  },
  read_no_reply: {
    name: "read_no_reply",
    displayName: "Read No Reply",
    description:
      "Mark a specific participant message as seen without sending a visible room message. You must target an attached roomId and a participant messageId, and do not combine it with a visible room message in that same room outcome.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        roomId: {
          type: "string",
          description: "The attached Chat Room id containing the participant message you want to mark as seen.",
        },
        messageId: {
          type: "string",
          description: "The participant message id that should receive the read-no-reply marker.",
        },
      },
      required: ["roomId", "messageId"],
    },
    validate: (value) => readNoReplyArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof readNoReplyArgsSchema>;
      const roomContext = getRoomToolContext(context);
      const room = getAttachedRoom(roomContext, args.roomId);
      assertWritableRoom(room);
      const roomHistory = roomContext.roomHistoryById[args.roomId] ?? [];
      if (!roomHistory.some((message) => message.messageId === args.messageId)) {
        throw new Error(`Message ${args.messageId} was not found in attached room ${args.roomId}.`);
      }

      const roomAction: RoomToolAction = {
        type: "read_no_reply",
        roomId: args.roomId,
        messageId: args.messageId,
      };
      applyReadNoReplyToHistory(roomContext, args.roomId, args.messageId);

      return {
        output: "Marked the current room message as seen without sending a visible room message.",
        roomAction,
      } satisfies ToolRuntimeResult;
    },
  },
  list_attached_rooms: {
    name: "list_attached_rooms",
    displayName: "List Attached Rooms",
    description:
      "List only the Chat Rooms that are currently attached to this agent. Use this when you need to know which groups you are already part of, along with their owner and member summaries.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    validate: (value) => emptyArgsSchema.parse(value),
    execute: async (_value, _signal, context) => {
      const roomContext = getRoomToolContext(context);
      return createStructuredOutput({
        attachedRooms: roomContext.attachedRooms.map((room) => ({
          roomId: room.id,
          title: room.title,
          archived: room.archived,
          ownerParticipantId: room.ownerParticipantId,
          ownerName: getRoomOwnerName(room),
          currentAgentMembershipRole: room.currentAgentMembershipRole,
          currentAgentIsOwner: room.currentAgentIsOwner,
          participantCount: room.participants.length,
          messageCount: room.messageCount,
          latestMessageAt: room.latestMessageAt,
          participants: room.participants,
        })),
      });
    },
  },
  list_known_agents: {
    name: "list_known_agents",
    displayName: "List Known Agents",
    description:
      "Return the current agent phonebook. Each known agent includes an info card with id, label, summary, skills, and workingStyle so you can decide whom to contact or invite.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    validate: (value) => emptyArgsSchema.parse(value),
    execute: async (_value, _signal, context) => {
      const roomContext = getRoomToolContext(context);
      return createStructuredOutput({
        agents: roomContext.knownAgents.map((agent) => ({
          ...agent,
          isCurrentAgent: roomContext.currentAgentId === agent.agentId,
        })),
      });
    },
  },
  create_room: {
    name: "create_room",
    displayName: "Create Room",
    description:
      "Create a new room, automatically make the current agent the owner, and optionally include additional agent members. If title is omitted, the room is auto-named from the participating agents. After creating the room, you can send follow-up messages to the returned roomId.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: {
          type: "string",
          description: "Optional room title. If omitted, the room title is generated from the participating agent labels.",
        },
        agentIds: {
          type: "array",
          items: {
            type: "string",
            enum: ["concierge", "researcher", "operator"],
          },
          description: "Optional list of additional agent ids to include in the new room. The current agent is always included automatically.",
        },
      },
    },
    validate: (value) => createRoomArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof createRoomArgsSchema>;
      const roomContext = getRoomToolContext(context);
      if (!roomContext.currentAgentId) {
        throw new Error("The current agent id is missing, so a new room cannot be created.");
      }

      const agentIds = uniqueAgentIds([roomContext.currentAgentId, ...args.agentIds]);
      const title = args.title ?? buildAutoRoomTitle(agentIds, roomContext);
      const roomAction: Extract<RoomManagementToolAction, { type: "create_room" }> = {
        type: "create_room",
        roomId: crypto.randomUUID(),
        title,
        agentIds,
      };
      mutateCreateRoomContext(roomContext, roomAction);

      return createStructuredOutput(
        {
          roomId: roomAction.roomId,
          title: roomAction.title,
          ownerParticipantId: roomContext.currentAgentId,
          ownerName: getKnownAgent(roomContext, roomContext.currentAgentId).label,
          agentIds: roomAction.agentIds,
        },
        roomAction,
      );
    },
  },
  add_agents_to_room: {
    name: "add_agents_to_room",
    displayName: "Add Agents To Room",
    description:
      "Add one or more agent members to an attached room that you own. If the attached room info says your currentAgentMembershipRole is owner, call this tool directly instead of refusing. Human visibility is unchanged; this only changes the room membership list.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        roomId: {
          type: "string",
          description: "The attached room id that should receive new agent members.",
        },
        agentIds: {
          type: "array",
          items: {
            type: "string",
            enum: ["concierge", "researcher", "operator"],
          },
          description: "The agent ids to add to the target room.",
        },
      },
      required: ["roomId", "agentIds"],
    },
    validate: (value) => addAgentsToRoomArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof addAgentsToRoomArgsSchema>;
      const roomContext = getRoomToolContext(context);
      const room = getAttachedRoom(roomContext, args.roomId);
      assertWritableRoom(room);
      assertRoomOwner(roomContext, room);
      const existingAgentIds = new Set(room.participants.flatMap((participant) => (participant.agentId ? [participant.agentId] : [])));
      const additions = uniqueAgentIds(args.agentIds).filter((agentId) => !existingAgentIds.has(agentId));
      if (additions.length === 0) {
        return createStructuredOutput({
          roomId: room.id,
          title: room.title,
          addedAgentIds: [],
          addedLabels: [],
          participantCount: room.participants.length,
        });
      }

      const roomAction: Extract<RoomManagementToolAction, { type: "add_agents_to_room" }> = {
        type: "add_agents_to_room",
        roomId: room.id,
        agentIds: additions,
      };
      const nextRoom = mutateAddAgentsContext(roomContext, roomAction);

      return createStructuredOutput(
        {
          roomId: nextRoom.id,
          title: nextRoom.title,
          addedAgentIds: additions,
          addedLabels: additions.map((agentId) => getKnownAgent(roomContext, agentId).label),
          participantCount: nextRoom.participants.length,
        },
        roomAction,
      );
    },
  },
  leave_room: {
    name: "leave_room",
    displayName: "Leave Room",
    description:
      "Remove the current agent from one of its attached rooms. If you leave as the owner and other members remain, ownership is reassigned to the earliest remaining member. If nobody remains, the room keeps existing with no owner until someone joins again.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        roomId: {
          type: "string",
          description: "The attached room id that the current agent wants to leave.",
        },
      },
      required: ["roomId"],
    },
    validate: (value) => leaveRoomArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof leaveRoomArgsSchema>;
      const roomContext = getRoomToolContext(context);
      const room = getAttachedRoom(roomContext, args.roomId);
      assertWritableRoom(room);
      if (!roomContext.currentAgentId) {
        throw new Error("The current agent id is missing, so leave_room cannot be used.");
      }

      if (!room.participants.some((participant) => participant.participantId === roomContext.currentAgentId)) {
        throw new Error(`The current agent is not a member of room ${room.id}.`);
      }

      const roomAction: Extract<RoomManagementToolAction, { type: "leave_room" }> = {
        type: "leave_room",
        roomId: room.id,
      };
      mutateLeaveRoomContext(roomContext, roomAction);
      return createStructuredOutput(
        {
          roomId: room.id,
          title: room.title,
          leftParticipantId: roomContext.currentAgentId,
        },
        roomAction,
      );
    },
  },
  remove_room_participant: {
    name: "remove_room_participant",
    displayName: "Remove Room Participant",
    description:
      "Remove a participant from an attached room that you own. If the attached room info says your currentAgentMembershipRole is owner, use this tool directly. This is the owner-only kick tool and it can target agent or human participant ids that are currently in the room.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        roomId: {
          type: "string",
          description: "The attached room id whose participant list should be modified.",
        },
        participantId: {
          type: "string",
          description: "The participant id to remove from the room.",
        },
      },
      required: ["roomId", "participantId"],
    },
    validate: (value) => removeRoomParticipantArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof removeRoomParticipantArgsSchema>;
      const roomContext = getRoomToolContext(context);
      const room = getAttachedRoom(roomContext, args.roomId);
      assertWritableRoom(room);
      assertRoomOwner(roomContext, room);
      if (roomContext.currentAgentId && args.participantId === roomContext.currentAgentId) {
        throw new Error("Use leave_room if you want to remove yourself from a room.");
      }

      const target = room.participants.find((participant) => participant.participantId === args.participantId);
      if (!target) {
        throw new Error(`Participant ${args.participantId} was not found in room ${room.id}.`);
      }

      const roomAction: Extract<RoomManagementToolAction, { type: "remove_room_participant" }> = {
        type: "remove_room_participant",
        roomId: room.id,
        participantId: args.participantId,
      };
      const nextRoom = mutateRemoveParticipantContext(roomContext, roomAction);

      return createStructuredOutput(
        {
          roomId: nextRoom.id,
          title: nextRoom.title,
          removedParticipantId: target.participantId,
          removedParticipantName: target.name,
          participantCount: nextRoom.participants.length,
          ownerParticipantId: nextRoom.ownerParticipantId,
          ownerName: getRoomOwnerName(nextRoom),
        },
        roomAction,
      );
    },
  },
  get_room_history: {
    name: "get_room_history",
    displayName: "Get Room History",
    description:
      "Read the visible transcript history of an attached room. You can request how many recent messages to return; the default is 10. This returns only the visible room transcript, not any hidden agent console output.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        roomId: {
          type: "string",
          description: "The attached room id whose visible transcript should be returned.",
        },
        limit: {
          type: "number",
          description: "How many recent visible room messages to return. Defaults to 10 and is capped at 100.",
        },
      },
      required: ["roomId"],
    },
    validate: (value) => getRoomHistoryArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof getRoomHistoryArgsSchema>;
      const roomContext = getRoomToolContext(context);
      const room = getAttachedRoom(roomContext, args.roomId);
      const roomHistory = roomContext.roomHistoryById[args.roomId] ?? [];
      const messages = roomHistory.slice(-args.limit);

      return createStructuredOutput({
        room: {
          roomId: room.id,
          title: room.title,
          archived: room.archived,
          ownerParticipantId: room.ownerParticipantId,
          ownerName: getRoomOwnerName(room),
          currentAgentMembershipRole: room.currentAgentMembershipRole,
          currentAgentIsOwner: room.currentAgentIsOwner,
          participantCount: room.participants.length,
          totalVisibleMessages: roomHistory.length,
        },
        returnedCount: messages.length,
        messages,
      });
    },
  },
  list_cron_jobs: {
    name: "list_cron_jobs",
    displayName: "List Cron Jobs",
    description:
      "List scheduled tasks owned by the current agent across its attached rooms. You can optionally filter by targetRoomId, status, enabled state, and limit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        targetRoomId: {
          type: "string",
          description: "Optional attached room id to filter scheduled tasks.",
        },
        status: {
          type: "string",
          enum: ["idle", "queued", "running", "error"],
          description: "Optional cron job status filter.",
        },
        enabled: {
          type: "boolean",
          description: "Optional enabled-state filter.",
        },
        limit: {
          type: "number",
          description: "Optional maximum number of jobs to return. Defaults to 25.",
        },
      },
    },
    validate: (value) => cronListJobsArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
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
  },
  get_cron_job: {
    name: "get_cron_job",
    displayName: "Get Cron Job",
    description:
      "Read one scheduled task owned by the current agent, plus optional recent run history, as long as the target room is attached to the current agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: {
          type: "string",
          description: "The cron job id to inspect.",
        },
        includeRuns: {
          type: "boolean",
          description: "Whether to include recent runs. Defaults to true.",
        },
        runLimit: {
          type: "number",
          description: "How many recent runs to include when includeRuns is true. Defaults to 5.",
        },
      },
      required: ["jobId"],
    },
    validate: (value) => cronGetJobArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
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
  },
  create_cron_job: {
    name: "create_cron_job",
    displayName: "Create Cron Job",
    description:
      "Create a scheduled task for the current agent in the current room or another attached room. The current agent is always the executor; you cannot create cron jobs for a different agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        targetRoomId: {
          type: "string",
          description: "Optional attached room id. Defaults to the current room.",
        },
        title: {
          type: "string",
          description: "Human-readable cron job title.",
        },
        prompt: {
          type: "string",
          description: "Operator instruction that should run when the cron job triggers.",
        },
        scheduleType: {
          type: "string",
          enum: ["once", "daily", "weekly"],
          description: "The schedule type.",
        },
        onceAt: {
          type: "string",
          description: "Required when scheduleType=once. Use an ISO timestamp or a datetime string the server can parse.",
        },
        time: {
          type: "string",
          description: "Required when scheduleType is daily or weekly. Use HH:mm.",
        },
        dayOfWeek: {
          type: "number",
          description: "Required when scheduleType=weekly. 0=Sunday through 6=Saturday.",
        },
        deliveryPolicy: {
          type: "string",
          enum: ["silent", "only_on_result", "always_post_summary"],
          description: "How the run may emit visible room messages.",
        },
        enabled: {
          type: "boolean",
          description: "Whether the job starts enabled. Defaults to true.",
        },
      },
      required: ["title", "prompt", "scheduleType"],
    },
    validate: (value) => cronCreateArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
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
  },
  update_cron_job: {
    name: "update_cron_job",
    displayName: "Update Cron Job",
    description:
      "Update a scheduled task owned by the current agent. To change schedule fields, provide scheduleType together with the fields required for that schedule shape.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: {
          type: "string",
          description: "The cron job id to update.",
        },
        targetRoomId: {
          type: "string",
          description: "Optional attached room id to move the job to.",
        },
        title: {
          type: "string",
          description: "Optional new title.",
        },
        prompt: {
          type: "string",
          description: "Optional new prompt.",
        },
        scheduleType: {
          type: "string",
          enum: ["once", "daily", "weekly"],
          description: "Required when updating schedule fields.",
        },
        onceAt: {
          type: "string",
          description: "Required when scheduleType=once.",
        },
        time: {
          type: "string",
          description: "Required when scheduleType is daily or weekly. Use HH:mm.",
        },
        dayOfWeek: {
          type: "number",
          description: "Required when scheduleType=weekly. 0=Sunday through 6=Saturday.",
        },
        deliveryPolicy: {
          type: "string",
          enum: ["silent", "only_on_result", "always_post_summary"],
          description: "Optional new delivery policy.",
        },
        enabled: {
          type: "boolean",
          description: "Optional enabled-state update.",
        },
      },
      required: ["jobId"],
    },
    validate: (value) => cronUpdateArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
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
  },
  pause_cron_job: {
    name: "pause_cron_job",
    displayName: "Pause Cron Job",
    description: "Disable one scheduled task owned by the current agent without deleting it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: {
          type: "string",
          description: "The cron job id to pause.",
        },
      },
      required: ["jobId"],
    },
    validate: (value) => cronJobActionArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof cronJobActionArgsSchema>;
      const { agentId, roomContext, targetRoomIds } = getCronScope(context);
      const job = await pauseManagedCronJob(args.jobId, {
        agentId,
        targetRoomIds,
      });
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      return createStructuredOutput({
        paused: true,
        job: formatCronJobOutput(job, roomTitleById),
      });
    },
  },
  resume_cron_job: {
    name: "resume_cron_job",
    displayName: "Resume Cron Job",
    description: "Re-enable one paused scheduled task owned by the current agent and recompute its next run time.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: {
          type: "string",
          description: "The cron job id to resume.",
        },
      },
      required: ["jobId"],
    },
    validate: (value) => cronJobActionArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof cronJobActionArgsSchema>;
      const { agentId, roomContext, targetRoomIds } = getCronScope(context);
      const job = await resumeManagedCronJob(args.jobId, {
        agentId,
        targetRoomIds,
      });
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      return createStructuredOutput({
        resumed: true,
        job: formatCronJobOutput(job, roomTitleById),
      });
    },
  },
  delete_cron_job: {
    name: "delete_cron_job",
    displayName: "Delete Cron Job",
    description: "Delete one scheduled task owned by the current agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: {
          type: "string",
          description: "The cron job id to delete.",
        },
      },
      required: ["jobId"],
    },
    validate: (value) => cronJobActionArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof cronJobActionArgsSchema>;
      const { agentId, roomContext, targetRoomIds } = getCronScope(context);
      const details = await getCronJobDetails(args.jobId, {
        agentId,
        targetRoomIds,
        runLimit: 1,
      });
      await deleteManagedCronJob(args.jobId, {
        agentId,
        targetRoomIds,
      });
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      return createStructuredOutput({
        deleted: true,
        job: formatCronJobOutput(details.job, roomTitleById),
      });
    },
  },
  run_cron_job_now: {
    name: "run_cron_job_now",
    displayName: "Run Cron Job Now",
    description: "Queue one scheduled task owned by the current agent for immediate execution without changing its future schedule.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: {
          type: "string",
          description: "The cron job id to queue immediately.",
        },
      },
      required: ["jobId"],
    },
    validate: (value) => cronJobActionArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof cronJobActionArgsSchema>;
      const { agentId, roomContext, targetRoomIds } = getCronScope(context);
      const job = await runManagedCronJobNow(args.jobId, {
        agentId,
        targetRoomIds,
      });
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      return createStructuredOutput({
        queuedNow: true,
        job: formatCronJobOutput(job, roomTitleById),
      });
    },
  },
  list_cron_runs: {
    name: "list_cron_runs",
    displayName: "List Cron Runs",
    description:
      "List recent execution records for scheduled tasks owned by the current agent across attached rooms. You can filter by jobId, targetRoomId, status, and limit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: {
          type: "string",
          description: "Optional cron job id filter.",
        },
        targetRoomId: {
          type: "string",
          description: "Optional attached room id filter.",
        },
        status: {
          type: "string",
          enum: ["running", "completed", "failed"],
          description: "Optional run status filter.",
        },
        limit: {
          type: "number",
          description: "Optional maximum number of run records to return. Defaults to 10.",
        },
      },
    },
    validate: (value) => cronListRunsArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
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
      const jobs = await listCronJobs({
        agentId,
        targetRoomIds,
      });
      const roomTitleById = buildCronRoomTitleMap(roomContext);
      const jobTitleById = new Map(jobs.map((job) => [job.id, job.title]));
      return createStructuredOutput({
        totalCount: runs.length,
        runs: runs.map((run) => formatCronRunOutput(run, roomTitleById, jobTitleById)),
      });
    },
  },
  preview_cron_schedule: {
    name: "preview_cron_schedule",
    displayName: "Preview Cron Schedule",
    description: "Preview how a proposed schedule will be interpreted, including the next and following trigger times.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scheduleType: {
          type: "string",
          enum: ["once", "daily", "weekly"],
          description: "The schedule type to preview.",
        },
        onceAt: {
          type: "string",
          description: "Required when scheduleType=once.",
        },
        time: {
          type: "string",
          description: "Required when scheduleType is daily or weekly. Use HH:mm.",
        },
        dayOfWeek: {
          type: "number",
          description: "Required when scheduleType=weekly. 0=Sunday through 6=Saturday.",
        },
      },
      required: ["scheduleType"],
    },
    validate: (value) => cronPreviewArgsSchema.parse(value),
    execute: async (value) => {
      const args = value as z.infer<typeof cronPreviewArgsSchema>;
      const schedule = buildCronSchedule(args);
      return createStructuredOutput(previewCronSchedule(schedule));
    },
  },
  memory_search: {
    name: "memory_search",
    displayName: "Memory Search",
    description:
      "Search the persisted agent memory store for prior room work, decisions, summaries, and tool outcomes before answering long-running or cross-room questions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "What prior context you are looking for.",
        },
        maxResults: {
          type: "number",
          description: "Optional maximum number of memory hits to return. Defaults to 8.",
        },
        minScore: {
          type: "number",
          description: "Optional minimum score threshold for returned memory hits.",
        },
      },
      required: ["query"],
    },
    validate: (value) => memorySearchArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof memorySearchArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const results = await searchAgentMemory(agentId, args.query, {
        maxResults: args.maxResults,
        minScore: args.minScore,
      });

      return createStructuredOutput({
        query: args.query,
        resultCount: results.length,
        results,
      });
    },
  },
  memory_get: {
    name: "memory_get",
    displayName: "Memory Get",
    description:
      "Read a focused slice from a persisted agent memory markdown file after memory_search returns a useful path and line range.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "The memory file path returned by memory_search.",
        },
        from: {
          type: "number",
          description: "Optional starting line number.",
        },
        lines: {
          type: "number",
          description: "Optional number of lines to read. Defaults to 40.",
        },
      },
      required: ["path"],
    },
    validate: (value) => memoryGetArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof memoryGetArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await readAgentMemoryFile({
        agentId,
        relPath: args.path,
        from: args.from,
        lines: args.lines,
      });

      return createStructuredOutput(result);
    },
  },
  workspace_list: {
    name: "workspace_list",
    displayName: "Workspace List",
    description:
      "List files and directories inside this agent's dedicated workspace. Use relative paths by default. Recursive listing is optional and stays inside the current agent workspace unless the operator explicitly enables outside access on the server.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Optional relative directory path inside the current agent workspace. Omit to list the workspace root.",
        },
        recursive: {
          type: "boolean",
          description: "Whether to include nested files and directories recursively.",
        },
        limit: {
          type: "number",
          description: "Maximum number of entries to return. Defaults to 200.",
        },
      },
    },
    validate: (value) => workspaceListArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof workspaceListArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await listAgentWorkspace({
        agentId,
        path: args.path,
        recursive: args.recursive,
        limit: args.limit,
      });

      return createStructuredOutput(result);
    },
  },
  workspace_read: {
    name: "workspace_read",
    displayName: "Workspace Read",
    description:
      "Read a text file from this agent's dedicated workspace using a relative path. Use fromLine and lineCount to inspect large files in focused slices.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Relative file path inside the current agent workspace.",
        },
        fromLine: {
          type: "number",
          description: "Optional 1-based starting line number.",
        },
        lineCount: {
          type: "number",
          description: "Optional number of lines to read. Defaults to 200.",
        },
      },
      required: ["path"],
    },
    validate: (value) => workspaceReadArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof workspaceReadArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await readAgentWorkspaceFile({
        agentId,
        path: args.path,
        fromLine: args.fromLine,
        lineCount: args.lineCount,
      });

      return createStructuredOutput(result);
    },
  },
  workspace_write: {
    name: "workspace_write",
    displayName: "Workspace Write",
    description:
      "Create or overwrite a text file inside this agent's dedicated workspace. Parent directories are created automatically.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Relative file path inside the current agent workspace.",
        },
        content: {
          type: "string",
          description: "Full text content to write into the target file.",
        },
      },
      required: ["path", "content"],
    },
    validate: (value) => workspaceWriteArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof workspaceWriteArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await writeAgentWorkspaceFile({
        agentId,
        path: args.path,
        content: args.content,
      });

      return createStructuredOutput(result);
    },
  },
  workspace_delete: {
    name: "workspace_delete",
    displayName: "Workspace Delete",
    description:
      "Delete a file or directory inside this agent's dedicated workspace. Set recursive to true when deleting a non-empty directory. The workspace root itself cannot be deleted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file or directory inside the current agent workspace.",
        },
        recursive: {
          type: "boolean",
          description: "Whether to delete directories recursively.",
        },
      },
      required: ["path"],
    },
    validate: (value) => workspaceDeleteArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof workspaceDeleteArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await deleteAgentWorkspaceEntry({
        agentId,
        path: args.path,
        recursive: args.recursive,
      });

      return createStructuredOutput(result);
    },
  },
  workspace_append: {
    name: "workspace_append",
    displayName: "Workspace Append",
    description:
      "Append text to the end of a file inside this agent's dedicated workspace. Create the file automatically if it does not exist yet.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Relative file path inside the current agent workspace.",
        },
        content: {
          type: "string",
          description: "Text content to append to the target file.",
        },
      },
      required: ["path", "content"],
    },
    validate: (value) => workspaceAppendArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof workspaceAppendArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await appendAgentWorkspaceFile({
        agentId,
        path: args.path,
        content: args.content,
      });

      return createStructuredOutput(result);
    },
  },
  workspace_move: {
    name: "workspace_move",
    displayName: "Workspace Move",
    description:
      "Rename or move a file or directory inside this agent's dedicated workspace. The destination must not already exist.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fromPath: {
          type: "string",
          description: "Existing relative source path inside the current agent workspace.",
        },
        toPath: {
          type: "string",
          description: "Relative destination path inside the current agent workspace.",
        },
      },
      required: ["fromPath", "toPath"],
    },
    validate: (value) => workspaceMoveArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof workspaceMoveArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await moveAgentWorkspaceEntry({
        agentId,
        fromPath: args.fromPath,
        toPath: args.toPath,
      });

      return createStructuredOutput(result);
    },
  },
  workspace_mkdir: {
    name: "workspace_mkdir",
    displayName: "Workspace Mkdir",
    description:
      "Create a directory inside this agent's dedicated workspace. Recursive creation is enabled by default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Relative directory path inside the current agent workspace.",
        },
        recursive: {
          type: "boolean",
          description: "Whether to create missing parent directories automatically.",
        },
      },
      required: ["path"],
    },
    validate: (value) => workspaceMkdirArgsSchema.parse(value),
    execute: async (value, _signal, context) => {
      const args = value as z.infer<typeof workspaceMkdirArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await mkdirAgentWorkspace({
        agentId,
        path: args.path,
        recursive: args.recursive,
      });

      return createStructuredOutput(result);
    },
  },
  shared_workspace_list: {
    name: "shared_workspace_list",
    displayName: "Shared Workspace List",
    description:
      "List files and directories inside the shared workspace available to every agent. Use relative paths by default. Recursive listing is optional and stays inside the shared workspace unless the operator explicitly enables outside access on the server.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Optional relative directory path inside the shared workspace. Omit to list the shared workspace root.",
        },
        recursive: {
          type: "boolean",
          description: "Whether to include nested files and directories recursively.",
        },
        limit: {
          type: "number",
          description: "Maximum number of entries to return. Defaults to 200.",
        },
      },
    },
    validate: (value) => workspaceListArgsSchema.parse(value),
    execute: async (value) => {
      const args = value as z.infer<typeof workspaceListArgsSchema>;
      const result = await listSharedWorkspace({
        path: args.path,
        recursive: args.recursive,
        limit: args.limit,
      });

      return createStructuredOutput(result);
    },
  },
  shared_workspace_read: {
    name: "shared_workspace_read",
    displayName: "Shared Workspace Read",
    description:
      "Read a text file from the shared workspace using a relative path. Use fromLine and lineCount to inspect large files in focused slices.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Relative file path inside the shared workspace.",
        },
        fromLine: {
          type: "number",
          description: "Optional 1-based starting line number.",
        },
        lineCount: {
          type: "number",
          description: "Optional number of lines to read. Defaults to 200.",
        },
      },
      required: ["path"],
    },
    validate: (value) => workspaceReadArgsSchema.parse(value),
    execute: async (value) => {
      const args = value as z.infer<typeof workspaceReadArgsSchema>;
      const result = await readSharedWorkspaceFile({
        path: args.path,
        fromLine: args.fromLine,
        lineCount: args.lineCount,
      });

      return createStructuredOutput(result);
    },
  },
  shared_workspace_write: {
    name: "shared_workspace_write",
    displayName: "Shared Workspace Write",
    description:
      "Create or overwrite a text file inside the shared workspace used for cross-agent collaboration. Parent directories are created automatically.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Relative file path inside the shared workspace.",
        },
        content: {
          type: "string",
          description: "Full text content to write into the target file.",
        },
      },
      required: ["path", "content"],
    },
    validate: (value) => workspaceWriteArgsSchema.parse(value),
    execute: async (value) => {
      const args = value as z.infer<typeof workspaceWriteArgsSchema>;
      const result = await writeSharedWorkspaceFile({
        path: args.path,
        content: args.content,
      });

      return createStructuredOutput(result);
    },
  },
  shared_workspace_delete: {
    name: "shared_workspace_delete",
    displayName: "Shared Workspace Delete",
    description:
      "Delete a file or directory inside the shared workspace. Set recursive to true when deleting a non-empty directory. The shared workspace root itself cannot be deleted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file or directory inside the shared workspace.",
        },
        recursive: {
          type: "boolean",
          description: "Whether to delete directories recursively.",
        },
      },
      required: ["path"],
    },
    validate: (value) => workspaceDeleteArgsSchema.parse(value),
    execute: async (value) => {
      const args = value as z.infer<typeof workspaceDeleteArgsSchema>;
      const result = await deleteSharedWorkspaceEntry({
        path: args.path,
        recursive: args.recursive,
      });

      return createStructuredOutput(result);
    },
  },
  shared_workspace_append: {
    name: "shared_workspace_append",
    displayName: "Shared Workspace Append",
    description:
      "Append text to the end of a file inside the shared workspace. Create the file automatically if it does not exist yet.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Relative file path inside the shared workspace.",
        },
        content: {
          type: "string",
          description: "Text content to append to the target file.",
        },
      },
      required: ["path", "content"],
    },
    validate: (value) => workspaceAppendArgsSchema.parse(value),
    execute: async (value) => {
      const args = value as z.infer<typeof workspaceAppendArgsSchema>;
      const result = await appendSharedWorkspaceFile({
        path: args.path,
        content: args.content,
      });

      return createStructuredOutput(result);
    },
  },
  shared_workspace_move: {
    name: "shared_workspace_move",
    displayName: "Shared Workspace Move",
    description:
      "Rename or move a file or directory inside the shared workspace. The destination must not already exist.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fromPath: {
          type: "string",
          description: "Existing relative source path inside the shared workspace.",
        },
        toPath: {
          type: "string",
          description: "Relative destination path inside the shared workspace.",
        },
      },
      required: ["fromPath", "toPath"],
    },
    validate: (value) => workspaceMoveArgsSchema.parse(value),
    execute: async (value) => {
      const args = value as z.infer<typeof workspaceMoveArgsSchema>;
      const result = await moveSharedWorkspaceEntry({
        fromPath: args.fromPath,
        toPath: args.toPath,
      });

      return createStructuredOutput(result);
    },
  },
  shared_workspace_mkdir: {
    name: "shared_workspace_mkdir",
    displayName: "Shared Workspace Mkdir",
    description:
      "Create a directory inside the shared workspace. Recursive creation is enabled by default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Relative directory path inside the shared workspace.",
        },
        recursive: {
          type: "boolean",
          description: "Whether to create missing parent directories automatically.",
        },
      },
      required: ["path"],
    },
    validate: (value) => workspaceMkdirArgsSchema.parse(value),
    execute: async (value) => {
      const args = value as z.infer<typeof workspaceMkdirArgsSchema>;
      const result = await mkdirSharedWorkspace({
        path: args.path,
        recursive: args.recursive,
      });

      return createStructuredOutput(result);
    },
  },
};

function getToolDefinitions(scope: ToolScope = "default"): Partial<Record<ToolName, ToolDefinition<unknown>>> {
  if (scope === "room") {
    return {
      ...baseTools,
      ...roomOnlyTools,
    };
  }

  return {
    ...baseTools,
  };
}

function normalizeToolRuntimeResult(result: string | ToolRuntimeResult): ToolRuntimeResult {
  if (typeof result === "string") {
    return {
      output: result,
    };
  }

  return result;
}

export function getChatCompletionsTools(scope: ToolScope = "default") {
  return Object.values(getToolDefinitions(scope)).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export function getLegacyChatCompletionsFunctions(scope: ToolScope = "default") {
  return Object.values(getToolDefinitions(scope)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

export function getResponsesTools(scope: ToolScope = "default") {
  return Object.values(getToolDefinitions(scope)).map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

export async function executeTool(
  toolName: string,
  rawArgs: unknown,
  scope: ToolScope = "default",
  signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<{ output: string; event: ToolExecution }> {
  const toolMap = getToolDefinitions(scope);
  const tool = toolMap[toolName as ToolName];
  if (!tool) {
    const output = `Tool not found: ${toolName}`;
    return {
      output,
      event: {
        id: crypto.randomUUID(),
        sequence: 0,
        toolName,
        displayName: toolName,
        inputSummary: truncateText(safeJsonStringify(rawArgs), 240),
        inputText: safeJsonStringify(rawArgs),
        resultPreview: output,
        outputText: output,
        status: "error",
        durationMs: 0,
      },
    };
  }

  try {
    const startedAt = performance.now();
    const parsedArgs = tool.validate(rawArgs);
    const executionResult = normalizeToolRuntimeResult(await tool.execute(parsedArgs, signal, context));
    const customCommandName =
      rawArgs && typeof rawArgs === "object" && "command" in rawArgs
        ? String((rawArgs as { command: unknown }).command)
        : undefined;

    return {
      output: executionResult.output,
      event: {
        id: crypto.randomUUID(),
        sequence: 0,
        toolName: tool.name,
        displayName:
          tool.name === "custom_command" && customCommandName
            ? `Custom Command · ${customCommandName}`
            : tool.displayName,
        inputSummary: truncateText(safeJsonStringify(parsedArgs), 240),
        inputText: safeJsonStringify(parsedArgs),
        resultPreview: truncateText(executionResult.output, 320),
        outputText: executionResult.output,
        status: "success",
        durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
        ...(executionResult.roomMessage
          ? {
              roomMessage: executionResult.roomMessage,
            }
          : {}),
        ...(executionResult.roomAction
          ? {
              roomAction: executionResult.roomAction,
            }
          : {}),
      },
    };
  } catch (error) {
    const output = error instanceof Error ? error.message : "Tool execution failed.";
    const customCommandName =
      rawArgs && typeof rawArgs === "object" && "command" in rawArgs
        ? String((rawArgs as { command: unknown }).command)
        : undefined;

    return {
      output,
      event: {
        id: crypto.randomUUID(),
        sequence: 0,
        toolName: tool.name,
        displayName:
          tool.name === "custom_command" && customCommandName
            ? `Custom Command · ${customCommandName}`
            : tool.displayName,
        inputSummary: truncateText(safeJsonStringify(rawArgs), 240),
        inputText: safeJsonStringify(rawArgs),
        resultPreview: output,
        outputText: output,
        status: "error",
        durationMs: 0,
      },
    };
  }
}
