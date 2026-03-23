import { NextResponse } from "next/server";
import { z } from "zod";
import type { RoomCronSchedule } from "@/lib/chat/types";
import { ensureCronDispatcherStarted } from "@/lib/server/cron-dispatcher";
import { createCronJob, loadCronStore, mutateCronStore } from "@/lib/server/cron-store";
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

const createSchema = z.object({
  agentId: z.enum(["concierge", "researcher", "operator"]),
  targetRoomId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(4000),
  schedule: scheduleSchema,
  deliveryPolicy: z.enum(["silent", "only_on_result", "always_post_summary"]),
  enabled: z.boolean().optional().default(true),
});

function normalizeResponse(store: Awaited<ReturnType<typeof loadCronStore>>, roomId?: string | null) {
  return {
    jobs: roomId ? store.jobs.filter((job) => job.targetRoomId === roomId) : store.jobs,
    runs: roomId ? store.runs.filter((run) => run.targetRoomId === roomId) : store.runs,
  };
}

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

export async function GET(request: Request) {
  ensureCronDispatcherStarted();
  const { searchParams } = new URL(request.url);
  const roomId = searchParams.get("roomId");
  const store = await loadCronStore();
  return NextResponse.json(normalizeResponse(store, roomId));
}

export async function POST(request: Request) {
  try {
    ensureCronDispatcherStarted();
    const payload = createSchema.parse(await request.json());
    await validateJobTarget(payload.agentId, payload.targetRoomId);
    const job = createCronJob({
      agentId: payload.agentId,
      targetRoomId: payload.targetRoomId,
      title: payload.title,
      prompt: payload.prompt,
      schedule: payload.schedule as RoomCronSchedule,
      deliveryPolicy: payload.deliveryPolicy,
      enabled: payload.enabled,
    });
    const store = await mutateCronStore((current) => ({
      ...current,
      jobs: [job, ...current.jobs],
    }));
    return NextResponse.json({ ok: true, ...normalizeResponse(store, job.targetRoomId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
