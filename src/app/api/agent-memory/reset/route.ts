import { NextResponse } from "next/server";
import { z } from "zod";
import { resetAgentRoomSession } from "@/lib/server/agent-room-sessions";

export const runtime = "nodejs";

const requestSchema = z.object({
  agentId: z.string().trim().min(1).max(120),
});

export async function POST(request: Request) {
  try {
    const payload = requestSchema.parse(await request.json());
    await resetAgentRoomSession(payload.agentId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
