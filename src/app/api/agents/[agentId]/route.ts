import { NextResponse } from "next/server";
import { z } from "zod";
import { updateAgentDefinition } from "@/lib/server/agent-registry";

export const runtime = "nodejs";

const mutationSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  summary: z.string().trim().min(1).max(500).optional(),
  skills: z.array(z.string().trim().min(1).max(120)).max(24).optional(),
  workingStyle: z.string().trim().min(1).max(500).optional(),
  instruction: z.string().max(8_000).optional(),
});

export async function PUT(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const payload = mutationSchema.parse(await request.json());
    const { agentId } = await context.params;
    const agent = await updateAgentDefinition(agentId, payload);
    return NextResponse.json({ agent });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    const status = message === "Agent not found." ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
