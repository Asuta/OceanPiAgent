import { NextResponse } from "next/server";
import { z } from "zod";
import { loadPersistedAgentRuntime } from "@/lib/server/agent-runtime-store";

export const runtime = "nodejs";

const querySchema = z.object({
  agentId: z.string().trim().min(1).max(120),
});

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const payload = querySchema.parse({
      agentId: url.searchParams.get("agentId") ?? "",
    });
    const runtimeState = await loadPersistedAgentRuntime(payload.agentId);
    return NextResponse.json({
      ok: true,
      compactions: runtimeState.compactions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
