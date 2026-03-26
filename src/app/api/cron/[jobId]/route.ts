import { NextResponse } from "next/server";
import { z } from "zod";
import type { RoomCronSchedule } from "@/lib/chat/types";
import { ensureCronDispatcherStarted } from "@/lib/server/cron-dispatcher";
import { deleteManagedCronJob, listCronJobs, listCronRuns, updateManagedCronJob } from "@/lib/server/cron-service";

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
  agentId: z.string().trim().min(1).max(120).optional(),
  targetRoomId: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().min(1).max(4000).optional(),
  schedule: scheduleSchema.optional(),
  deliveryPolicy: z.enum(["silent", "only_on_result", "always_post_summary"]).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    ensureCronDispatcherStarted();
    const { jobId } = await context.params;
    const payload = updateSchema.parse(await request.json());
    const job = await updateManagedCronJob(jobId, {
      agentId: payload.agentId,
      targetRoomId: payload.targetRoomId,
      title: payload.title,
      prompt: payload.prompt,
      schedule: payload.schedule as RoomCronSchedule | undefined,
      deliveryPolicy: payload.deliveryPolicy,
      enabled: payload.enabled,
    });
    const [jobs, runs] = await Promise.all([
      listCronJobs({ roomId: job.targetRoomId }),
      listCronRuns({ roomId: job.targetRoomId }),
    ]);
    return NextResponse.json({ ok: true, jobs, runs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    const status = message === "Cron job not found." ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    ensureCronDispatcherStarted();
    const { jobId } = await context.params;
    await deleteManagedCronJob(jobId);
    const [jobs, runs] = await Promise.all([listCronJobs(), listCronRuns()]);
    return NextResponse.json({ ok: true, jobs, runs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    const status = message === "Cron job not found." ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
