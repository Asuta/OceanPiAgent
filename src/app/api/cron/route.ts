import { NextResponse } from "next/server";
import { z } from "zod";
import type { RoomCronSchedule } from "@/lib/chat/types";
import { ensureCronDispatcherStarted } from "@/lib/server/cron-dispatcher";
import { createManagedCronJob, listCronJobs, listCronRuns } from "@/lib/server/cron-service";

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

const createSchema = z.object({
  agentId: z.enum(["concierge", "researcher", "operator"]),
  targetRoomId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(4000),
  schedule: scheduleSchema,
  deliveryPolicy: z.enum(["silent", "only_on_result", "always_post_summary"]),
  enabled: z.boolean().optional().default(true),
});

export async function GET(request: Request) {
  ensureCronDispatcherStarted();
  const { searchParams } = new URL(request.url);
  const roomId = searchParams.get("roomId");
  const [jobs, runs] = await Promise.all([
    listCronJobs({ roomId: roomId ?? undefined }),
    listCronRuns({ roomId: roomId ?? undefined }),
  ]);
  return NextResponse.json({ jobs, runs });
}

export async function POST(request: Request) {
  try {
    ensureCronDispatcherStarted();
    const payload = createSchema.parse(await request.json());
    const job = await createManagedCronJob({
      agentId: payload.agentId,
      targetRoomId: payload.targetRoomId,
      title: payload.title,
      prompt: payload.prompt,
      schedule: payload.schedule as RoomCronSchedule,
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
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
