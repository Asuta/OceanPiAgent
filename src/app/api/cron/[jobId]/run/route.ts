import { NextResponse } from "next/server";
import { enqueueCronJobNow, ensureCronDispatcherStarted } from "@/lib/server/cron-dispatcher";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    ensureCronDispatcherStarted();
    const { jobId } = await context.params;
    await enqueueCronJobNow(jobId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
