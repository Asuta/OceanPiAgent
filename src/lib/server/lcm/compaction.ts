import { createHash } from "node:crypto";
import { generateCompactionSummary } from "@/lib/server/agent-compaction";
import { estimateTokens } from "./estimate-tokens";
import type { ConversationStore, MessageRecord } from "./conversation-store";
import type { ContextItemRecord, SummaryStore } from "./summary-store";

export interface CompactionConfig {
  contextThreshold: number;
  freshTailCount: number;
  leafMinFanout: number;
  condensedMinFanout: number;
  condensedMinFanoutHard: number;
  incrementalMaxDepth: number;
  leafChunkTokens?: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  maxRounds: number;
  timezone?: string;
}

export interface CompactionResult {
  actionTaken: boolean;
  tokensBefore: number;
  tokensAfter: number;
  createdSummaryId?: string;
  condensed: boolean;
  level?: "normal" | "aggressive" | "fallback";
}

const DEFAULT_LEAF_CHUNK_TOKENS = 20_000;

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function generateSummaryId(content: string): string {
  return `sum_${createHash("sha256").update(`${content}:${Date.now()}`).digest("hex").slice(0, 16)}`;
}

export class CompactionEngine {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private config: CompactionConfig,
  ) {}

  async compact(input: { conversationId: number; tokenBudget: number; force?: boolean; summaryModel?: string }): Promise<CompactionResult> {
    return this.compactFullSweep(input);
  }

  async compactFullSweep(input: { conversationId: number; tokenBudget: number; force?: boolean; summaryModel?: string }): Promise<CompactionResult> {
    const threshold = Math.floor(this.config.contextThreshold * input.tokenBudget);
    const tokensBefore = await this.summaryStore.getContextTokenCount(input.conversationId);
    if (!input.force && tokensBefore <= threshold) {
      return { actionTaken: false, tokensBefore, tokensAfter: tokensBefore, condensed: false };
    }

    let previousTokens = tokensBefore;
    let actionTaken = false;
    let condensed = false;
    let createdSummaryId: string | undefined;

    while (true) {
      const chunk = await this.selectOldestLeafChunk(input.conversationId, input.force);
      if (chunk.length === 0) {
        break;
      }
      const leaf = await this.leafPass(input.conversationId, chunk, input.summaryModel);
      if (!leaf) {
        break;
      }
      const afterLeaf = await this.summaryStore.getContextTokenCount(input.conversationId);
      actionTaken = true;
      createdSummaryId = leaf;
      if (!input.force && afterLeaf <= threshold) {
        previousTokens = afterLeaf;
        break;
      }
      if (afterLeaf >= previousTokens) {
        previousTokens = afterLeaf;
        break;
      }
      previousTokens = afterLeaf;
    }

    while (input.force || previousTokens > threshold) {
      const candidate = await this.selectOldestSummaryChunk(input.conversationId, input.force);
      if (candidate.length < this.config.condensedMinFanout) {
        break;
      }
      const condensedSummaryId = await this.condensedPass(input.conversationId, candidate, input.summaryModel);
      if (!condensedSummaryId) {
        break;
      }
      const afterCondensed = await this.summaryStore.getContextTokenCount(input.conversationId);
      actionTaken = true;
      condensed = true;
      createdSummaryId = condensedSummaryId;
      if (!input.force && afterCondensed <= threshold) {
        previousTokens = afterCondensed;
        break;
      }
      if (afterCondensed >= previousTokens) {
        previousTokens = afterCondensed;
        break;
      }
      previousTokens = afterCondensed;
    }

    return {
      actionTaken,
      tokensBefore,
      tokensAfter: await this.summaryStore.getContextTokenCount(input.conversationId),
      createdSummaryId,
      condensed,
      level: actionTaken ? "normal" : undefined,
    };
  }

  private resolveFreshTailOrdinal(items: ContextItemRecord[], force?: boolean): number {
    if (force) {
      return Number.POSITIVE_INFINITY;
    }
    const rawMessages = items.filter((item) => item.itemType === "message" && item.messageId != null);
    if (rawMessages.length === 0) {
      return Number.POSITIVE_INFINITY;
    }
    const tailStartIdx = Math.max(0, rawMessages.length - this.config.freshTailCount);
    return rawMessages[tailStartIdx]?.ordinal ?? Number.POSITIVE_INFINITY;
  }

  private async selectOldestLeafChunk(conversationId: number, force?: boolean): Promise<ContextItemRecord[]> {
    const items = await this.summaryStore.getContextItems(conversationId);
    const freshTailOrdinal = this.resolveFreshTailOrdinal(items, force);
    const threshold = this.config.leafChunkTokens ?? DEFAULT_LEAF_CHUNK_TOKENS;
    const chunk: ContextItemRecord[] = [];
    let tokens = 0;
    let started = false;
    for (const item of items) {
      if (item.ordinal >= freshTailOrdinal) break;
      if (!started) {
        if (item.itemType !== "message" || item.messageId == null) continue;
        started = true;
      } else if (item.itemType !== "message" || item.messageId == null) {
        break;
      }
      const message = await this.conversationStore.getMessageById(item.messageId!);
      if (!message) continue;
      if (chunk.length > 0 && tokens + message.tokenCount > threshold) break;
      chunk.push(item);
      tokens += message.tokenCount;
      if (tokens >= threshold) break;
    }
    return chunk;
  }

  private async selectOldestSummaryChunk(conversationId: number, force?: boolean): Promise<ContextItemRecord[]> {
    const items = await this.summaryStore.getContextItems(conversationId);
    const freshTailOrdinal = this.resolveFreshTailOrdinal(items, force);
    const chunk: ContextItemRecord[] = [];
    let targetDepth: number | null = null;
    let tokens = 0;
    const threshold = this.config.leafChunkTokens ?? DEFAULT_LEAF_CHUNK_TOKENS;
    for (const item of items) {
      if (item.ordinal >= freshTailOrdinal) break;
      if (item.itemType !== "summary" || item.summaryId == null) {
        if (chunk.length > 0) break;
        continue;
      }
      const summary = await this.summaryStore.getSummary(item.summaryId);
      if (!summary) continue;
      if (targetDepth == null) {
        targetDepth = summary.depth;
      }
      if (summary.depth !== targetDepth) {
        if (chunk.length > 0) break;
        continue;
      }
      if (chunk.length > 0 && tokens + summary.tokenCount > threshold) break;
      chunk.push(item);
      tokens += summary.tokenCount;
      if (tokens >= threshold) break;
    }
    return chunk;
  }

  private async leafPass(conversationId: number, items: ContextItemRecord[], summaryModel?: string): Promise<string | null> {
    const messages: MessageRecord[] = [];
    for (const item of items) {
      if (item.messageId == null) continue;
      const message = await this.conversationStore.getMessageById(item.messageId);
      if (message) messages.push(message);
    }
    if (messages.length === 0) return null;
    const sourceText = messages.map((message) => `[${formatTimestamp(message.createdAt)}]\n${message.content}`).join("\n\n");
    const summaryContent = await generateCompactionSummary({
      agentId: `conversation:${conversationId}`,
      messages: messages.map((message) => ({ id: String(message.messageId), role: message.role === "system" ? "user" : (message.role === "tool" ? "assistant" : message.role), content: message.content, attachments: [], createdAt: message.createdAt.toISOString() })),
      resolvedModel: summaryModel ?? "unknown",
    });
    const summaryId = generateSummaryId(summaryContent);
    await this.summaryStore.insertSummary({
      summaryId,
      conversationId,
      kind: "leaf",
      depth: 0,
      content: summaryContent,
      tokenCount: estimateTokens(summaryContent),
      earliestAt: new Date(Math.min(...messages.map((message) => message.createdAt.getTime()))),
      latestAt: new Date(Math.max(...messages.map((message) => message.createdAt.getTime()))),
      descendantCount: 0,
      descendantTokenCount: 0,
      sourceMessageTokenCount: messages.reduce((sum, message) => sum + message.tokenCount, 0),
      model: summaryModel ?? "unknown",
    });
    await this.summaryStore.linkSummaryToMessages(summaryId, messages.map((message) => message.messageId));
    await this.summaryStore.replaceContextRangeWithSummary({
      conversationId,
      startOrdinal: Math.min(...items.map((item) => item.ordinal)),
      endOrdinal: Math.max(...items.map((item) => item.ordinal)),
      summaryId,
    });
    void sourceText;
    return summaryId;
  }

  private async condensedPass(conversationId: number, items: ContextItemRecord[], summaryModel?: string): Promise<string | null> {
    const summaries = (await Promise.all(items.map((item) => item.summaryId ? this.summaryStore.getSummary(item.summaryId) : Promise.resolve(null)))).filter((summary): summary is NonNullable<typeof summary> => Boolean(summary));
    if (summaries.length === 0) return null;
    const summaryContent = await generateCompactionSummary({
      agentId: `conversation:${conversationId}`,
      messages: summaries.map((summary) => ({ id: summary.summaryId, role: "assistant", content: summary.content, attachments: [], createdAt: summary.createdAt.toISOString() })),
      resolvedModel: summaryModel ?? "unknown",
    });
    const summaryId = generateSummaryId(summaryContent);
    await this.summaryStore.insertSummary({
      summaryId,
      conversationId,
      kind: "condensed",
      depth: Math.max(...summaries.map((summary) => summary.depth)) + 1,
      content: summaryContent,
      tokenCount: estimateTokens(summaryContent),
      earliestAt: new Date(Math.min(...summaries.map((summary) => (summary.earliestAt ?? summary.createdAt).getTime()))),
      latestAt: new Date(Math.max(...summaries.map((summary) => (summary.latestAt ?? summary.createdAt).getTime()))),
      descendantCount: summaries.reduce((count, summary) => count + summary.descendantCount + 1, 0),
      descendantTokenCount: summaries.reduce((count, summary) => count + summary.descendantTokenCount + summary.tokenCount, 0),
      sourceMessageTokenCount: summaries.reduce((count, summary) => count + summary.sourceMessageTokenCount, 0),
      model: summaryModel ?? "unknown",
    });
    await this.summaryStore.linkSummaryToParents(summaryId, summaries.map((summary) => summary.summaryId));
    await this.summaryStore.replaceContextRangeWithSummary({
      conversationId,
      startOrdinal: Math.min(...items.map((item) => item.ordinal)),
      endOrdinal: Math.max(...items.map((item) => item.ordinal)),
      summaryId,
    });
    return summaryId;
  }
}
