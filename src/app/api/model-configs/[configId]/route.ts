import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteModelConfig, updateModelConfig } from "@/lib/server/model-config-store";

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

export async function PUT(request: Request, context: { params: Promise<{ configId: string }> }) {
  try {
    const payload = mutationSchema.parse(await request.json());
    const { configId } = await context.params;
    const modelConfig = await updateModelConfig(configId, payload);
    if (!modelConfig) {
      return NextResponse.json({ error: "Model config not found." }, { status: 404 });
    }

    return NextResponse.json({ modelConfig });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ configId: string }> }) {
  const { configId } = await context.params;
  const deleted = await deleteModelConfig(configId);
  if (!deleted) {
    return NextResponse.json({ error: "Model config not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
