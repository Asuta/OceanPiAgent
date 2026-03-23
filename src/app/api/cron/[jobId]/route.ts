import { NextResponse } from "next/server";
import { z } from "zod";
import type { RoomCronSchedule } from "@/lib/chat/types";
import { ensureCronDispatcherStarted } from "@/lib/server/cron-dispatcher";
import { computeNextRunAt, loadCronStore, mutateCronStore } from "@/lib/server/cron-store";
import { loadWorkspaceEnvelope } from "@/lib/server/workspace-store";

export const runtime = "nodejs";

const scheduleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("once"),
    at: z.string().min(1),
  }),
  z.object({
    type: z.literal("daily"),
    time: z.string().regex(/^\d{2}:\d{2}$/),
  }),
  z.object({
    type: z.literal("weekly"),
    dayOfWeek: z.number().int().min(0).max(6),
    time: z.string().regex(/^\d{2}:\d{2}$/),
  }),
]);

const updateSchema = z.object({
  agentId: z.enum(["concierge", "researcher", "operator"]).optional(),
  targetRoomId: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().min(1).max(4000).optional(),
  schedule: scheduleSchema.optional(),
  deliveryPolicy: z.enum(["silent", "only_on_result", "always_post_summary"]).optional(),
  enabled: z.boolean().optional(),
});

async function validateJobTarget(agentId: string, targetRoomId: string): Promise<void> {
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

export async function PATCH(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    ensureCronDispatcherStarted();
    const { jobId } = await context.params;
    const payload = updateSchema.parse(await request.json());
    const currentStore = await loadCronStore();
    const currentJob = currentStore.jobs.find((job) => job.id === jobId);
    if (!currentJob) {
      return NextResponse.json({ error: "Cron job not found." }, { status: 404 });
    }

    const nextAgentId = payload.agentId ?? currentJob.agentId;
    const nextRoomId = payload.targetRoomId ?? currentJob.targetRoomId;
    await validateJobTarget(nextAgentId, nextRoomId);

    const store = await mutateCronStore((snapshot) => ({
      ...snapshot,
      jobs: snapshot.jobs.map((job) => {
        if (job.id !== jobId) {
          return job;
        }
        const schedule = (payload.schedule as RoomCronSchedule | undefined) ?? job.schedule;
        const enabled = payload.enabled ?? job.enabled;
        return {
          ...job,
          agentId: nextAgentId,
          targetRoomId: nextRoomId,
          title: payload.title ?? job.title,
          prompt: payload.prompt ?? job.prompt,
          schedule,
          deliveryPolicy: payload.deliveryPolicy ?? job.deliveryPolicy,
          enabled,
          nextRunAt: enabled ? computeNextRunAt(schedule) ?? job.nextRunAt : null,
          updatedAt: new Date().toISOString(),
        };
      }),
    }));

    return NextResponse.json({ ok: true, jobs: store.jobs, runs: store.runs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  ensureCronDispatcherStarted();
  const { jobId } = await context.params;
  const store = await mutateCronStore((snapshot) => ({
    ...snapshot,
    jobs: snapshot.jobs.filter((job) => job.id !== jobId),
  }));
  return NextResponse.json({ ok: true, jobs: store.jobs, runs: store.runs });
}
