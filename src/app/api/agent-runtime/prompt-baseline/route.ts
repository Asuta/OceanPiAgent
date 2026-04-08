import { NextResponse } from "next/server";
import { z } from "zod";
import { estimateAgentPromptTokens } from "@/lib/server/agent-prompt-token-estimate";
import { loadPersistedAgentRuntime } from "@/lib/server/agent-runtime-store";
import { assembleAgentLcmContext } from "@/lib/server/lcm/facade";

export const runtime = "nodejs";

const querySchema = z.object({
  agentId: z.array(z.string().trim().min(1).max(120)).min(1),
});

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const payload = querySchema.parse({
      agentId: url.searchParams.getAll("agentId"),
    });

    const baselines = await Promise.all(payload.agentId.map(async (agentId) => {
      const runtimeState = await loadPersistedAgentRuntime(agentId);
      const assembled = await assembleAgentLcmContext(agentId, 20_000).catch(() => null);
      const estimate = await estimateAgentPromptTokens({
        agentId,
        contextTokens: assembled?.estimatedTokens ?? 0,
        history: runtimeState.history,
        systemPromptAddition: assembled?.systemPromptAddition,
      }).catch(() => null);

      return {
        agentId,
        promptOverheadTokens: estimate?.promptOverheadTokens ?? 0,
        systemPromptTokens: estimate?.systemPromptTokens ?? 0,
        toolSchemaTokens: estimate?.toolSchemaTokens ?? 0,
        attachmentTokens: estimate?.attachmentTokens ?? 0,
      };
    }));

    return NextResponse.json({
      ok: true,
      baselines,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
