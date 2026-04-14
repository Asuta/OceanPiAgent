import { createHash } from "node:crypto";
import { generateCompactionSummary } from "@/lib/server/agent-compaction";
import type { CompactionModelSelection } from "@/lib/server/agent-compaction-settings";
import { extractFileIdsFromContent } from "./large-files";
import { estimateTokens } from "./estimate-tokens";
import type { ConversationStore, CreateMessagePartInput } from "./conversation-store";
import type { SummaryStore, SummaryRecord, ContextItemRecord } from "./summary-store";

export interface CompactionDecision {
  shouldCompact: boolean;
  reason: "threshold" | "manual" | "none";
  currentTokens: number;
  threshold: number;
}

export interface CompactionResult {
  actionTaken: boolean;
  tokensBefore: number;
  tokensAfter: number;
  createdSummaryId?: string;
  condensed: boolean;
  level?: CompactionLevel;
  skipReason?: "below_threshold" | "empty_context" | "no_eligible_leaf_chunk" | "leaf_pass_failed" | "no_condensation_candidate";
}

export interface CompactionConfig {
  fixedTokenThreshold: number;
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

type CompactionThresholdInput = {
  force?: boolean;
  storedTokens: number;
  comparisonExtraTokens?: number;
};

type CompactionLevel = "normal" | "aggressive" | "fallback";
type CompactionPass = "leaf" | "condensed";
type PassResult = { summaryId: string; level: CompactionLevel; content?: string };
type LeafChunkSelection = { items: ContextItemRecord[] };
type CondensedChunkSelection = { items: ContextItemRecord[]; summaryTokens: number };
type CondensedPhaseCandidate = { targetDepth: number; chunk: CondensedChunkSelection };

const DEFAULT_LEAF_CHUNK_TOKENS = 20_000;
const FALLBACK_MAX_CHARS = 512 * 4;
const CONDENSED_MIN_INPUT_RATIO = 0.1;
const MEDIA_PATH_RE = /^MEDIA:\/.+$/;

function getSummaryModelLabel(selection?: CompactionModelSelection): string | undefined {
  if (!selection) {
    return undefined;
  }
  return selection.resolvedModel.trim() || selection.settings.model.trim() || undefined;
}

function shortTzAbbr(value: Date, timezone: string): string {
  try {
    const abbr = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    }).formatToParts(value).find((part) => part.type === "timeZoneName")?.value;
    return abbr ?? timezone;
  } catch {
    return timezone;
  }
}

export function formatTimestamp(value: Date, timezone: string = "UTC"): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(value).map((part) => [part.type, part.value]));
    const tzAbbr = timezone === "UTC" ? "UTC" : shortTzAbbr(value, timezone);
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${tzAbbr}`;
  } catch {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    const hours = String(value.getUTCHours()).padStart(2, "0");
    const minutes = String(value.getUTCMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
  }
}

function generateSummaryId(content: string): string {
  return `sum_${createHash("sha256").update(content + Date.now().toString()).digest("hex").slice(0, 16)}`;
}

function dedupeOrderedIds(ids: Iterable<string>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

export class CompactionEngine {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private config: CompactionConfig,
  ) {}

  async evaluate(conversationId: number, tokenBudget: number, observedTokenCount?: number): Promise<CompactionDecision> {
    void tokenBudget;
    const storedTokens = await this.summaryStore.getContextTokenCount(conversationId);
    const liveTokens = typeof observedTokenCount === "number" && Number.isFinite(observedTokenCount) && observedTokenCount > 0 ? Math.floor(observedTokenCount) : 0;
    const currentTokens = Math.max(storedTokens, liveTokens);
    const threshold = this.resolveFixedTokenThreshold();

    if (currentTokens > threshold) {
      return { shouldCompact: true, reason: "threshold", currentTokens, threshold };
    }
    return { shouldCompact: false, reason: "none", currentTokens, threshold };
  }

  async compact(input: { conversationId: number; tokenBudget: number; force?: boolean; hardTrigger?: boolean; summaryModelSelection?: CompactionModelSelection; comparisonExtraTokens?: number }): Promise<CompactionResult> {
    return this.compactFullSweep(input);
  }

  async compactLeaf(input: { conversationId: number; tokenBudget: number; force?: boolean; previousSummaryContent?: string; summaryModelSelection?: CompactionModelSelection; comparisonExtraTokens?: number }): Promise<CompactionResult> {
    const tokensBefore = await this.summaryStore.getContextTokenCount(input.conversationId);

    if (this.isBelowThreshold({ force: input.force, storedTokens: tokensBefore, comparisonExtraTokens: input.comparisonExtraTokens })) {
      return { actionTaken: false, tokensBefore, tokensAfter: tokensBefore, condensed: false, skipReason: "below_threshold" };
    }

    const leafChunk = await this.selectOldestLeafChunk(input.conversationId, input.force);
    if (leafChunk.items.length === 0) {
      return { actionTaken: false, tokensBefore, tokensAfter: tokensBefore, condensed: false, skipReason: "no_eligible_leaf_chunk" };
    }

    const previousSummaryContent = input.previousSummaryContent ?? await this.resolvePriorLeafSummaryContext(input.conversationId, leafChunk.items);
    const leafResult = await this.leafPass(input.conversationId, leafChunk.items, previousSummaryContent, input.summaryModelSelection);
    if (!leafResult) {
      return { actionTaken: false, tokensBefore, tokensAfter: tokensBefore, condensed: false, skipReason: "leaf_pass_failed" };
    }

    const tokensAfterLeaf = await this.summaryStore.getContextTokenCount(input.conversationId);
    await this.persistCompactionEvents({
      conversationId: input.conversationId,
      tokensBefore,
      tokensAfterLeaf,
      tokensAfterFinal: tokensAfterLeaf,
      leafResult: { summaryId: leafResult.summaryId, level: leafResult.level },
      condenseResult: null,
    });

    let tokensAfter = tokensAfterLeaf;
    let condensed = false;
    let createdSummaryId = leafResult.summaryId;
    let level = leafResult.level;

    const incrementalMaxDepth = this.resolveIncrementalMaxDepth();
    const condensedMinChunkTokens = this.resolveCondensedMinChunkTokens();
    if (incrementalMaxDepth > 0) {
      for (let targetDepth = 0; targetDepth < incrementalMaxDepth; targetDepth += 1) {
        const fanout = this.resolveFanoutForDepth(targetDepth, false);
        const chunk = await this.selectOldestChunkAtDepth(input.conversationId, targetDepth);
        if (chunk.items.length < fanout || chunk.summaryTokens < condensedMinChunkTokens) {
          break;
        }

        const passTokensBefore = await this.summaryStore.getContextTokenCount(input.conversationId);
        const condenseResult = await this.condensedPass(input.conversationId, chunk.items, targetDepth, input.summaryModelSelection);
        if (!condenseResult) {
          break;
        }
        const passTokensAfter = await this.summaryStore.getContextTokenCount(input.conversationId);
        await this.persistCompactionEvents({
          conversationId: input.conversationId,
          tokensBefore: passTokensBefore,
          tokensAfterLeaf: passTokensBefore,
          tokensAfterFinal: passTokensAfter,
          leafResult: null,
          condenseResult,
        });

        tokensAfter = passTokensAfter;
        condensed = true;
        createdSummaryId = condenseResult.summaryId;
        level = condenseResult.level;

        if (passTokensAfter >= passTokensBefore) {
          break;
        }
      }
    }

    return {
      actionTaken: true,
      tokensBefore,
      tokensAfter,
      createdSummaryId,
      condensed,
      level,
    };
  }

  async compactFullSweep(input: { conversationId: number; tokenBudget: number; force?: boolean; hardTrigger?: boolean; summaryModelSelection?: CompactionModelSelection; comparisonExtraTokens?: number }): Promise<CompactionResult> {
    const tokensBefore = await this.summaryStore.getContextTokenCount(input.conversationId);

    if (this.isBelowThreshold({ force: input.force, storedTokens: tokensBefore, comparisonExtraTokens: input.comparisonExtraTokens })) {
      return { actionTaken: false, tokensBefore, tokensAfter: tokensBefore, condensed: false, skipReason: "below_threshold" };
    }

    const contextItems = await this.summaryStore.getContextItems(input.conversationId);
    if (contextItems.length === 0) {
      return { actionTaken: false, tokensBefore, tokensAfter: tokensBefore, condensed: false, skipReason: "empty_context" };
    }

    let actionTaken = false;
    let condensed = false;
    let createdSummaryId: string | undefined;
    let level: CompactionLevel | undefined;
    let previousSummaryContent: string | undefined;
    let previousTokens = tokensBefore;

    while (true) {
      const leafChunk = await this.selectOldestLeafChunk(input.conversationId, input.force);
      if (leafChunk.items.length === 0) {
        break;
      }

      const passTokensBefore = await this.summaryStore.getContextTokenCount(input.conversationId);
      const leafResult = await this.leafPass(input.conversationId, leafChunk.items, previousSummaryContent, input.summaryModelSelection);
      if (!leafResult) {
        return {
          actionTaken,
          tokensBefore,
          tokensAfter: previousTokens,
          createdSummaryId,
          condensed,
          level,
          skipReason: actionTaken ? undefined : "leaf_pass_failed",
        };
      }

      const passTokensAfter = await this.summaryStore.getContextTokenCount(input.conversationId);
      await this.persistCompactionEvents({
        conversationId: input.conversationId,
        tokensBefore: passTokensBefore,
        tokensAfterLeaf: passTokensAfter,
        tokensAfterFinal: passTokensAfter,
        leafResult: { summaryId: leafResult.summaryId, level: leafResult.level },
        condenseResult: null,
      });

      actionTaken = true;
      createdSummaryId = leafResult.summaryId;
      level = leafResult.level;
      previousSummaryContent = leafResult.content;

      if (passTokensAfter >= passTokensBefore || passTokensAfter >= previousTokens) {
        break;
      }
      previousTokens = passTokensAfter;
    }

    while (!this.isBelowThreshold({ force: input.force, storedTokens: previousTokens, comparisonExtraTokens: input.comparisonExtraTokens })) {
      const candidate = await this.selectShallowestCondensationCandidate({
        conversationId: input.conversationId,
        hardTrigger: input.hardTrigger === true,
        force: input.force,
      });
      if (!candidate) {
        return {
          actionTaken,
          tokensBefore,
          tokensAfter: previousTokens,
          createdSummaryId,
          condensed,
          level,
          skipReason: actionTaken ? undefined : "no_condensation_candidate",
        };
      }

      const passTokensBefore = await this.summaryStore.getContextTokenCount(input.conversationId);
      const condenseResult = await this.condensedPass(input.conversationId, candidate.chunk.items, candidate.targetDepth, input.summaryModelSelection);
      if (!condenseResult) {
        break;
      }

      const passTokensAfter = await this.summaryStore.getContextTokenCount(input.conversationId);
      await this.persistCompactionEvents({
        conversationId: input.conversationId,
        tokensBefore: passTokensBefore,
        tokensAfterLeaf: passTokensBefore,
        tokensAfterFinal: passTokensAfter,
        leafResult: null,
        condenseResult,
      });

      actionTaken = true;
      condensed = true;
      createdSummaryId = condenseResult.summaryId;
      level = condenseResult.level;

      if (this.isBelowThreshold({ force: input.force, storedTokens: passTokensAfter, comparisonExtraTokens: input.comparisonExtraTokens })) {
        previousTokens = passTokensAfter;
        break;
      }
      if (passTokensAfter >= passTokensBefore || passTokensAfter >= previousTokens) {
        break;
      }
      previousTokens = passTokensAfter;
    }

    const tokensAfter = await this.summaryStore.getContextTokenCount(input.conversationId);
    return {
      actionTaken,
      tokensBefore,
      tokensAfter,
      createdSummaryId,
      condensed,
      level,
      ...(actionTaken ? {} : { skipReason: "no_eligible_leaf_chunk" as const }),
    };
  }

  async compactUntilUnder(input: { conversationId: number; tokenBudget: number; targetTokens?: number; currentTokens?: number; summaryModelSelection?: CompactionModelSelection }): Promise<{ success: boolean; rounds: number; finalTokens: number }> {
    const targetTokens = typeof input.targetTokens === "number" && Number.isFinite(input.targetTokens) && input.targetTokens > 0 ? Math.floor(input.targetTokens) : input.tokenBudget;
    const storedTokens = await this.summaryStore.getContextTokenCount(input.conversationId);
    const liveTokens = typeof input.currentTokens === "number" && Number.isFinite(input.currentTokens) && input.currentTokens > 0 ? Math.floor(input.currentTokens) : 0;
    let lastTokens = Math.max(storedTokens, liveTokens);

    if (lastTokens < targetTokens) {
      return { success: true, rounds: 0, finalTokens: lastTokens };
    }

    for (let round = 1; round <= this.config.maxRounds; round += 1) {
      const result = await this.compact({
        conversationId: input.conversationId,
        tokenBudget: input.tokenBudget,
        force: true,
        summaryModelSelection: input.summaryModelSelection,
      });

      if (result.tokensAfter <= targetTokens) {
        return { success: true, rounds: round, finalTokens: result.tokensAfter };
      }
      if (!result.actionTaken || result.tokensAfter >= lastTokens) {
        return { success: false, rounds: round, finalTokens: result.tokensAfter };
      }
      lastTokens = result.tokensAfter;
    }

    const finalTokens = await this.summaryStore.getContextTokenCount(input.conversationId);
    return {
      success: finalTokens <= targetTokens,
      rounds: this.config.maxRounds,
      finalTokens,
    };
  }

  private isBelowThreshold(input: CompactionThresholdInput): boolean {
    if (input.force) {
      return false;
    }

    const comparisonExtraTokens =
      typeof input.comparisonExtraTokens === "number" && Number.isFinite(input.comparisonExtraTokens)
        ? Math.floor(input.comparisonExtraTokens)
        : 0;
    return input.storedTokens + comparisonExtraTokens <= this.resolveFixedTokenThreshold();
  }

  private resolveLeafChunkTokens(): number {
    if (typeof this.config.leafChunkTokens === "number" && Number.isFinite(this.config.leafChunkTokens) && this.config.leafChunkTokens > 0) {
      return Math.floor(this.config.leafChunkTokens);
    }
    return DEFAULT_LEAF_CHUNK_TOKENS;
  }

  private resolveFixedTokenThreshold(): number {
    return Math.max(1, Math.floor(this.config.fixedTokenThreshold));
  }

  private resolveFreshTailCount(): number {
    if (typeof this.config.freshTailCount === "number" && Number.isFinite(this.config.freshTailCount) && this.config.freshTailCount > 0) {
      return Math.floor(this.config.freshTailCount);
    }
    return 0;
  }

  private resolveFreshTailOrdinal(contextItems: ContextItemRecord[]): number {
    const freshTailCount = this.resolveFreshTailCount();
    if (freshTailCount <= 0) {
      return Infinity;
    }

    const rawMessageItems = contextItems.filter((item) => item.itemType === "message" && item.messageId != null);
    if (rawMessageItems.length === 0) {
      return Infinity;
    }

    const tailStartIdx = Math.max(0, rawMessageItems.length - freshTailCount);
    return rawMessageItems[tailStartIdx]?.ordinal ?? Infinity;
  }

  private async getMessageTokenCount(messageId: number): Promise<number> {
    const message = await this.conversationStore.getMessageById(messageId);
    if (!message) {
      return 0;
    }
    if (typeof message.tokenCount === "number" && Number.isFinite(message.tokenCount) && message.tokenCount > 0) {
      return message.tokenCount;
    }
    return estimateTokens(message.content);
  }

  private async selectOldestLeafChunk(conversationId: number, force?: boolean): Promise<LeafChunkSelection> {
    const contextItems = await this.summaryStore.getContextItems(conversationId);
    const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
    const threshold = this.resolveLeafChunkTokens();
    void force;

    const chunk: ContextItemRecord[] = [];
    let chunkTokens = 0;
    let started = false;
    for (const item of contextItems) {
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }

      if (!started) {
        if (item.itemType !== "message" || item.messageId == null) {
          continue;
        }
        started = true;
      } else if (item.itemType !== "message" || item.messageId == null) {
        break;
      }

      const messageTokens = await this.getMessageTokenCount(item.messageId!);
      if (chunk.length > 0 && chunkTokens + messageTokens > threshold) {
        break;
      }

      chunk.push(item);
      chunkTokens += messageTokens;
      if (chunkTokens >= threshold) {
        break;
      }
    }

    return { items: chunk };
  }

  private async resolvePriorLeafSummaryContext(conversationId: number, messageItems: ContextItemRecord[]): Promise<string | undefined> {
    if (messageItems.length === 0) {
      return undefined;
    }
    const startOrdinal = Math.min(...messageItems.map((item) => item.ordinal));
    const priorSummaryItems = (await this.summaryStore.getContextItems(conversationId))
      .filter((item) => item.ordinal < startOrdinal && item.itemType === "summary" && typeof item.summaryId === "string")
      .slice(-2);

    const summaryContents: string[] = [];
    for (const item of priorSummaryItems) {
      const summary = await this.summaryStore.getSummary(item.summaryId!);
      const content = summary?.content.trim();
      if (content) {
        summaryContents.push(content);
      }
    }

    return summaryContents.length > 0 ? summaryContents.join("\n\n") : undefined;
  }

  private resolveSummaryTokenCount(summary: SummaryRecord): number {
    if (typeof summary.tokenCount === "number" && Number.isFinite(summary.tokenCount) && summary.tokenCount > 0) {
      return summary.tokenCount;
    }
    return estimateTokens(summary.content);
  }

  private resolveMessageTokenCount(message: { tokenCount: number; content: string }): number {
    if (typeof message.tokenCount === "number" && Number.isFinite(message.tokenCount) && message.tokenCount > 0) {
      return message.tokenCount;
    }
    return estimateTokens(message.content);
  }

  private resolveLeafMinFanout(): number {
    if (typeof this.config.leafMinFanout === "number" && Number.isFinite(this.config.leafMinFanout) && this.config.leafMinFanout > 0) {
      return Math.floor(this.config.leafMinFanout);
    }
    return 8;
  }

  private resolveCondensedMinFanout(): number {
    if (typeof this.config.condensedMinFanout === "number" && Number.isFinite(this.config.condensedMinFanout) && this.config.condensedMinFanout > 0) {
      return Math.floor(this.config.condensedMinFanout);
    }
    return 4;
  }

  private resolveCondensedMinFanoutHard(): number {
    if (typeof this.config.condensedMinFanoutHard === "number" && Number.isFinite(this.config.condensedMinFanoutHard) && this.config.condensedMinFanoutHard > 0) {
      return Math.floor(this.config.condensedMinFanoutHard);
    }
    return 2;
  }

  private resolveIncrementalMaxDepth(): number {
    if (typeof this.config.incrementalMaxDepth === "number" && Number.isFinite(this.config.incrementalMaxDepth)) {
      if (this.config.incrementalMaxDepth < 0) {
        return Infinity;
      }
      if (this.config.incrementalMaxDepth > 0) {
        return Math.floor(this.config.incrementalMaxDepth);
      }
    }
    return 0;
  }

  private resolveFanoutForDepth(targetDepth: number, hardTrigger: boolean): number {
    if (hardTrigger) {
      return this.resolveCondensedMinFanoutHard();
    }
    if (targetDepth === 0) {
      return this.resolveLeafMinFanout();
    }
    return this.resolveCondensedMinFanout();
  }

  private resolveCondensedMinChunkTokens(): number {
    const chunkTarget = this.resolveLeafChunkTokens();
    const ratioFloor = Math.floor(chunkTarget * CONDENSED_MIN_INPUT_RATIO);
    return Math.max(this.config.condensedTargetTokens, ratioFloor);
  }

  private async selectShallowestCondensationCandidate(params: { conversationId: number; hardTrigger: boolean; force?: boolean }): Promise<CondensedPhaseCandidate | null> {
    const contextItems = await this.summaryStore.getContextItems(params.conversationId);
    const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
    const minChunkTokens = this.resolveCondensedMinChunkTokens();
    void params.force;
    const depthLevels = await this.summaryStore.getDistinctDepthsInContext(params.conversationId, { maxOrdinalExclusive: freshTailOrdinal });

    for (const targetDepth of depthLevels) {
      const fanout = this.resolveFanoutForDepth(targetDepth, params.hardTrigger);
      const chunk = await this.selectOldestChunkAtDepth(params.conversationId, targetDepth, freshTailOrdinal);
      if (chunk.items.length < fanout || chunk.summaryTokens < minChunkTokens) {
        continue;
      }
      return { targetDepth, chunk };
    }

    return null;
  }

  private async selectOldestChunkAtDepth(conversationId: number, targetDepth: number, freshTailOrdinalOverride?: number): Promise<CondensedChunkSelection> {
    const contextItems = await this.summaryStore.getContextItems(conversationId);
    const freshTailOrdinal = typeof freshTailOrdinalOverride === "number" ? freshTailOrdinalOverride : this.resolveFreshTailOrdinal(contextItems);
    const chunkTokenBudget = this.resolveLeafChunkTokens();

    const chunk: ContextItemRecord[] = [];
    let summaryTokens = 0;
    for (const item of contextItems) {
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }
      if (item.itemType !== "summary" || item.summaryId == null) {
        if (chunk.length > 0) {
          break;
        }
        continue;
      }

      const summary = await this.summaryStore.getSummary(item.summaryId);
      if (!summary) {
        if (chunk.length > 0) {
          break;
        }
        continue;
      }
      if (summary.depth !== targetDepth) {
        if (chunk.length > 0) {
          break;
        }
        continue;
      }

      const tokenCount = this.resolveSummaryTokenCount(summary);
      if (chunk.length > 0 && summaryTokens + tokenCount > chunkTokenBudget) {
        break;
      }

      chunk.push(item);
      summaryTokens += tokenCount;
      if (summaryTokens >= chunkTokenBudget) {
        break;
      }
    }

    return { items: chunk, summaryTokens };
  }

  private async resolvePriorSummaryContextAtDepth(conversationId: number, summaryItems: ContextItemRecord[], targetDepth: number): Promise<string | undefined> {
    if (summaryItems.length === 0) {
      return undefined;
    }

    const startOrdinal = Math.min(...summaryItems.map((item) => item.ordinal));
    const priorSummaryItems = (await this.summaryStore.getContextItems(conversationId))
      .filter((item) => item.ordinal < startOrdinal && item.itemType === "summary" && typeof item.summaryId === "string")
      .slice(-4);

    const summaryContents: string[] = [];
    for (const item of priorSummaryItems) {
      const summary = await this.summaryStore.getSummary(item.summaryId!);
      if (!summary || summary.depth !== targetDepth) {
        continue;
      }
      const content = summary.content.trim();
      if (content) {
        summaryContents.push(content);
      }
    }

    return summaryContents.length > 0 ? summaryContents.slice(-2).join("\n\n") : undefined;
  }

  private buildDeterministicFallback(sourceText: string): { content: string; level: CompactionLevel } {
    const inputTokens = Math.max(1, estimateTokens(sourceText));
    const truncated = sourceText.length > FALLBACK_MAX_CHARS ? sourceText.slice(0, FALLBACK_MAX_CHARS) : sourceText;
    return {
      content: `${truncated}\n[Truncated from ${inputTokens} tokens]`,
      level: "fallback",
    };
  }

  private async annotateMediaContent(messageId: number, content: string): Promise<string> {
    const parts = await this.conversationStore.getMessageParts(messageId);
    const hasMediaParts = parts.some((part) => part.partType === "file" || part.partType === "snapshot");
    if (!hasMediaParts) {
      return content;
    }

    const textWithoutPaths = content
      .split("\n")
      .filter((line) => !MEDIA_PATH_RE.test(line.trim()))
      .join("\n")
      .trim();

    if (textWithoutPaths.length === 0) {
      return "[Media attachment]";
    }
    return `${textWithoutPaths} [with media attachment]`;
  }

  private async summarizeMessages(
    agentId: string,
    messages: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: string }>,
    summaryModelSelection?: CompactionModelSelection,
  ): Promise<string> {
    const summary = await generateCompactionSummary({
      agentId: agentId as never,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        attachments: [],
        createdAt: message.createdAt,
      })),
      resolvedModel: getSummaryModelLabel(summaryModelSelection) ?? "unknown",
      ...(summaryModelSelection
        ? {
            settings: summaryModelSelection.settings,
            modelConfigOverrides: summaryModelSelection.modelConfigOverrides,
          }
        : {}),
    });
    return summary.trim();
  }

  private async leafPass(
    conversationId: number,
    messageItems: ContextItemRecord[],
    previousSummaryContent?: string,
    summaryModelSelection?: CompactionModelSelection,
  ): Promise<{ summaryId: string; level: CompactionLevel; content: string } | null> {
    const messageContents: { messageId: number; role: "user" | "assistant"; content: string; createdAt: Date; tokenCount: number }[] = [];
    for (const item of messageItems) {
      if (item.messageId == null) {
        continue;
      }
      const msg = await this.conversationStore.getMessageById(item.messageId);
      if (msg) {
        const annotatedContent = await this.annotateMediaContent(msg.messageId, msg.content);
        messageContents.push({
          messageId: msg.messageId,
          role: msg.role === "assistant" ? "assistant" : "user",
          content: annotatedContent,
          createdAt: msg.createdAt,
          tokenCount: this.resolveMessageTokenCount(msg),
        });
      }
    }

    const concatenated = messageContents.map((message) => `[${formatTimestamp(message.createdAt, this.config.timezone)}]\n${message.content}`).join("\n\n");
    let summaryContent = "";
    let level: CompactionLevel = "normal";
    try {
      summaryContent = await this.summarizeMessages(
        `conversation:${conversationId}`,
        messageContents.map((message) => ({
          id: String(message.messageId),
          role: message.role,
          content: `${previousSummaryContent ? `[Previous running summary]\n${previousSummaryContent}\n\n` : ""}${message.content}`,
          createdAt: message.createdAt.toISOString(),
        })),
        summaryModelSelection,
      );
    } catch {
      const fallback = this.buildDeterministicFallback(concatenated);
      summaryContent = fallback.content;
      level = fallback.level;
    }
    if (!summaryContent) {
      const fallback = this.buildDeterministicFallback(concatenated);
      summaryContent = fallback.content;
      level = fallback.level;
    }

    const fileIds = dedupeOrderedIds(messageContents.flatMap((message) => extractFileIdsFromContent(message.content)));
    const summaryId = generateSummaryId(summaryContent);
    await this.summaryStore.insertSummary({
      summaryId,
      conversationId,
      kind: "leaf",
      depth: 0,
      content: summaryContent,
      tokenCount: estimateTokens(summaryContent),
      fileIds,
      earliestAt: messageContents.length > 0 ? new Date(Math.min(...messageContents.map((message) => message.createdAt.getTime()))) : undefined,
      latestAt: messageContents.length > 0 ? new Date(Math.max(...messageContents.map((message) => message.createdAt.getTime()))) : undefined,
      descendantCount: 0,
      descendantTokenCount: 0,
      sourceMessageTokenCount: messageContents.reduce((sum, message) => sum + Math.max(0, Math.floor(message.tokenCount)), 0),
      model: getSummaryModelLabel(summaryModelSelection),
    });

    const messageIds = messageContents.map((message) => message.messageId);
    await this.summaryStore.linkSummaryToMessages(summaryId, messageIds);
    await this.summaryStore.replaceContextRangeWithSummary({
      conversationId,
      startOrdinal: Math.min(...messageItems.map((item) => item.ordinal)),
      endOrdinal: Math.max(...messageItems.map((item) => item.ordinal)),
      summaryId,
    });

    return { summaryId, level, content: summaryContent };
  }

  private async condensedPass(
    conversationId: number,
    summaryItems: ContextItemRecord[],
    targetDepth: number,
    summaryModelSelection?: CompactionModelSelection,
  ): Promise<PassResult | null> {
    const summaryRecords: SummaryRecord[] = [];
    for (const item of summaryItems) {
      if (item.summaryId == null) {
        continue;
      }
      const record = await this.summaryStore.getSummary(item.summaryId);
      if (record) {
        summaryRecords.push(record);
      }
    }
    if (summaryRecords.length === 0) {
      return null;
    }

    const concatenated = summaryRecords.map((summary) => {
      const earliestAt = summary.earliestAt ?? summary.createdAt;
      const latestAt = summary.latestAt ?? summary.createdAt;
      const header = `[${formatTimestamp(earliestAt, this.config.timezone)} - ${formatTimestamp(latestAt, this.config.timezone)}]`;
      return `${header}\n${summary.content}`;
    }).join("\n\n");

    const previousSummaryContent = targetDepth === 0 ? await this.resolvePriorSummaryContextAtDepth(conversationId, summaryItems, targetDepth) : undefined;

    let condensedContent = "";
    let level: CompactionLevel = "normal";
    try {
      condensedContent = await this.summarizeMessages(
        `conversation:${conversationId}`,
        summaryRecords.map((summary) => ({
          id: summary.summaryId,
          role: "assistant",
          content: `${previousSummaryContent ? `[Previous running summary]\n${previousSummaryContent}\n\n` : ""}${summary.content}`,
          createdAt: summary.createdAt.toISOString(),
        })),
        summaryModelSelection,
      );
    } catch {
      const fallback = this.buildDeterministicFallback(concatenated);
      condensedContent = fallback.content;
      level = fallback.level;
    }
    if (!condensedContent) {
      const fallback = this.buildDeterministicFallback(concatenated);
      condensedContent = fallback.content;
      level = fallback.level;
    }

    const fileIds = dedupeOrderedIds(summaryRecords.flatMap((summary) => [...summary.fileIds, ...extractFileIdsFromContent(summary.content)]));
    const summaryId = generateSummaryId(condensedContent);
    await this.summaryStore.insertSummary({
      summaryId,
      conversationId,
      kind: "condensed",
      depth: targetDepth + 1,
      content: condensedContent,
      tokenCount: estimateTokens(condensedContent),
      fileIds,
      earliestAt: new Date(Math.min(...summaryRecords.map((summary) => (summary.earliestAt ?? summary.createdAt).getTime()))),
      latestAt: new Date(Math.max(...summaryRecords.map((summary) => (summary.latestAt ?? summary.createdAt).getTime()))),
      descendantCount: summaryRecords.reduce((count, summary) => count + Math.max(0, summary.descendantCount) + 1, 0),
      descendantTokenCount: summaryRecords.reduce((count, summary) => count + Math.max(0, Math.floor(summary.tokenCount)) + Math.max(0, summary.descendantTokenCount), 0),
      sourceMessageTokenCount: summaryRecords.reduce((count, summary) => count + Math.max(0, summary.sourceMessageTokenCount), 0),
      model: getSummaryModelLabel(summaryModelSelection),
    });

    await this.summaryStore.linkSummaryToParents(summaryId, summaryRecords.map((summary) => summary.summaryId));
    await this.summaryStore.replaceContextRangeWithSummary({
      conversationId,
      startOrdinal: Math.min(...summaryItems.map((item) => item.ordinal)),
      endOrdinal: Math.max(...summaryItems.map((item) => item.ordinal)),
      summaryId,
    });

    return { summaryId, level };
  }

  private async persistCompactionEvents(input: {
    conversationId: number;
    tokensBefore: number;
    tokensAfterLeaf: number;
    tokensAfterFinal: number;
    leafResult: { summaryId: string; level: CompactionLevel } | null;
    condenseResult: { summaryId: string; level: CompactionLevel } | null;
  }): Promise<void> {
    if (!input.leafResult && !input.condenseResult) {
      return;
    }

    const conversation = await this.conversationStore.getConversation(input.conversationId);
    if (!conversation) {
      return;
    }

    const createdSummaryIds = [input.leafResult?.summaryId, input.condenseResult?.summaryId].filter((id): id is string => typeof id === "string" && id.length > 0);
    const condensedPassOccurred = input.condenseResult !== null;

    if (input.leafResult) {
      await this.persistCompactionEvent({
        conversationId: input.conversationId,
        sessionId: conversation.sessionId,
        pass: "leaf",
        level: input.leafResult.level,
        tokensBefore: input.tokensBefore,
        tokensAfter: input.tokensAfterLeaf,
        createdSummaryId: input.leafResult.summaryId,
        createdSummaryIds,
        condensedPassOccurred,
      });
    }

    if (input.condenseResult) {
      await this.persistCompactionEvent({
        conversationId: input.conversationId,
        sessionId: conversation.sessionId,
        pass: "condensed",
        level: input.condenseResult.level,
        tokensBefore: input.tokensAfterLeaf,
        tokensAfter: input.tokensAfterFinal,
        createdSummaryId: input.condenseResult.summaryId,
        createdSummaryIds,
        condensedPassOccurred,
      });
    }
  }

  private async persistCompactionEvent(input: {
    conversationId: number;
    sessionId: string;
    pass: CompactionPass;
    level: CompactionLevel;
    tokensBefore: number;
    tokensAfter: number;
    createdSummaryId: string;
    createdSummaryIds: string[];
    condensedPassOccurred: boolean;
  }): Promise<void> {
    const content = `LCM compaction ${input.pass} pass (${input.level}): ${input.tokensBefore} -> ${input.tokensAfter}`;
    const metadata = JSON.stringify({
      conversationId: input.conversationId,
      pass: input.pass,
      level: input.level,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter,
      createdSummaryId: input.createdSummaryId,
      createdSummaryIds: input.createdSummaryIds,
      condensedPassOccurred: input.condensedPassOccurred,
    });

    const writeEvent = async (): Promise<void> => {
      const seq = (await this.conversationStore.getMaxSeq(input.conversationId)) + 1;
      const eventMessage = await this.conversationStore.createMessage({
        conversationId: input.conversationId,
        seq,
        role: "system",
        content,
        tokenCount: estimateTokens(content),
      });

      const parts: CreateMessagePartInput[] = [
        {
          sessionId: input.sessionId,
          partType: "compaction",
          ordinal: 0,
          textContent: content,
          metadata,
        },
      ];
      await this.conversationStore.createMessageParts(eventMessage.messageId, parts);
    };

    try {
      await this.conversationStore.withTransaction(() => writeEvent());
    } catch {}
  }
}
