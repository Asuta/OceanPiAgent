import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgentMemoryStatus } from "@/lib/server/agent-memory-store";

export const runtime = "nodejs";

const searchParamsSchema = z.object({
  agentId: z.string().trim().min(1).max(120),
});

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const params = searchParamsSchema.parse({
      agentId: url.searchParams.get("agentId") ?? "",
    });
    const status = await getAgentMemoryStatus(params.agentId);
    return NextResponse.json(status, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
