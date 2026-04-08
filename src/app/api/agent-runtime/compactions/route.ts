import { NextResponse } from "next/server";
import { z } from "zod";
import { loadPersistedAgentRuntime } from "@/lib/server/agent-runtime-store";
import { getAgentLcmRetrieval } from "@/lib/server/lcm/facade";

export const runtime = "nodejs";

const querySchema = z.object({
  agentId: z.string().trim().min(1).max(120),
});

function truncateText(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "空内容";
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const payload = querySchema.parse({
      agentId: url.searchParams.get("agentId") ?? "",
    });
    const runtimeState = await loadPersistedAgentRuntime(payload.agentId);
    const { retrieval } = await getAgentLcmRetrieval(payload.agentId).catch(() => ({ retrieval: null }));
    const compactions = await Promise.all(
      runtimeState.compactions.map(async (record) => {
        if (!record.createdSummaryId || !retrieval) {
          return record;
        }

        const [described, expanded] = await Promise.all([
          retrieval.describe(record.createdSummaryId).catch(() => null),
          retrieval.expand({ summaryId: record.createdSummaryId, depth: 1, includeMessages: true, tokenCap: 1400 }).catch(() => null),
        ]);
        if (!described?.summary) {
          return record;
        }

        return {
          ...record,
          summaryRef: {
            summaryId: record.createdSummaryId,
            kind: described.summary.kind,
            depth: described.summary.depth,
            tokenCount: described.summary.tokenCount,
            sourceMessageTokenCount: described.summary.sourceMessageTokenCount,
            descendantCount: described.summary.descendantCount,
            descendantTokenCount: described.summary.descendantTokenCount,
            messageIds: described.summary.messageIds,
            parentIds: described.summary.parentIds,
            childIds: described.summary.childIds,
            subtree: described.summary.subtree.slice(0, 12).map((node) => ({
              summaryId: node.summaryId,
              parentSummaryId: node.parentSummaryId,
              depthFromRoot: node.depthFromRoot,
              kind: node.kind,
              depth: node.depth,
              tokenCount: node.tokenCount,
              childCount: node.childCount,
              sourceMessageTokenCount: node.sourceMessageTokenCount,
            })),
            directChildren: (expanded?.children ?? []).slice(0, 6).map((child) => ({
              summaryId: child.summaryId,
              kind: child.kind,
              tokenCount: child.tokenCount,
              preview: truncateText(child.content, 180),
            })),
            directMessages: (expanded?.messages ?? []).slice(0, 6).map((message) => ({
              messageId: message.messageId,
              role: message.role,
              tokenCount: message.tokenCount,
              preview: truncateText(message.content, 180),
            })),
            mappingTruncated: expanded?.truncated ?? false,
          },
        };
      }),
    );

    return NextResponse.json({
      ok: true,
      compactions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
