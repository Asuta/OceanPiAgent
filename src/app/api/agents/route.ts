import { NextResponse } from "next/server";
import { z } from "zod";
import { createAgentDefinition, listAgentDefinitions } from "@/lib/server/agent-registry";

export const runtime = "nodejs";

const mutationSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(500),
  skills: z.array(z.string().trim().min(1).max(120)).max(24).optional().default([]),
  workingStyle: z.string().trim().min(1).max(500),
  instruction: z.string().max(8_000).optional().default(""),
});

export async function GET() {
  const agents = await listAgentDefinitions();
  return NextResponse.json({ agents });
}

export async function POST(request: Request) {
  try {
    const payload = mutationSchema.parse(await request.json());
    const agent = await createAgentDefinition(payload);
    return NextResponse.json({ agent }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
