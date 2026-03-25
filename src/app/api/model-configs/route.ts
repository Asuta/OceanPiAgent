import { NextResponse } from "next/server";
import { z } from "zod";
import { createModelConfig, listModelConfigs } from "@/lib/server/model-config-store";

export const runtime = "nodejs";

const mutationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["openai_compatible", "pi_builtin"]),
  model: z.string().max(200).optional().default(""),
  apiFormat: z.enum(["chat_completions", "responses"]).optional().default("chat_completions"),
  baseUrl: z.string().max(500).optional().default(""),
  providerMode: z.enum(["auto", "openai", "right_codes", "generic"]).optional().default("auto"),
  apiKey: z.string().max(400).optional(),
  clearApiKey: z.boolean().optional().default(false),
});

export async function GET() {
  const modelConfigs = await listModelConfigs();
  return NextResponse.json({ modelConfigs });
}

export async function POST(request: Request) {
  try {
    const payload = mutationSchema.parse(await request.json());
    const modelConfig = await createModelConfig(payload);
    return NextResponse.json({ modelConfig }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
