import { NextResponse } from "next/server";
import { ensureCronDispatcherStarted } from "@/lib/server/cron-dispatcher";
import { runManagedCronJobNow } from "@/lib/server/cron-service";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    ensureCronDispatcherStarted();
    const { jobId } = await context.params;
    await runManagedCronJobNow(jobId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    const status = message === "Cron job not found." ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
