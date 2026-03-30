import { NextResponse } from "next/server";
import { z } from "zod";
import { reindexAgentMemory } from "@/lib/server/agent-memory-store";

export const runtime = "nodejs";

const requestSchema = z.object({
  agentId: z.string().trim().min(1).max(120),
  force: z.boolean().optional().default(false),
});

export async function POST(request: Request) {
  try {
    const payload = requestSchema.parse(await request.json());
    const result = await reindexAgentMemory(payload.agentId, { force: payload.force });
    return NextResponse.json({
      ok: true,
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
