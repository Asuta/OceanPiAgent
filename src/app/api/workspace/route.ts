import { NextResponse } from "next/server";
import { z } from "zod";
import type { RoomWorkspaceState } from "@/lib/chat/types";
import { ensureCronDispatcherStarted } from "@/lib/server/cron-dispatcher";
import { loadWorkspaceEnvelope, saveWorkspaceState } from "@/lib/server/workspace-store";

export const runtime = "nodejs";

const requestSchema = z.object({
  expectedVersion: z.number().int().min(0),
  state: z.unknown(),
});

export async function GET() {
  ensureCronDispatcherStarted();
  const envelope = await loadWorkspaceEnvelope();
  return NextResponse.json(envelope);
}

export async function PUT(request: Request) {
  try {
    ensureCronDispatcherStarted();
    const payload = requestSchema.parse(await request.json());
    const envelope = await saveWorkspaceState({
      expectedVersion: payload.expectedVersion,
      state: payload.state as RoomWorkspaceState,
    });
    return NextResponse.json(envelope);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as Error & { code?: string }).code === "VERSION_CONFLICT") {
      return NextResponse.json(
        {
          error: error.message,
          envelope: (error as Error & { envelope?: unknown }).envelope,
        },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
