import { estimateTokens } from "./estimate-tokens";
import type { ConversationStore } from "./conversation-store";
import type { SummaryStore } from "./summary-store";

export interface DescribeResult {
  id: string;
  type: "summary" | "file";
  summary?: {
    conversationId: number;
    kind: "leaf" | "condensed";
    content: string;
    depth: number;
    tokenCount: number;
    descendantCount: number;
    descendantTokenCount: number;
    sourceMessageTokenCount: number;
    fileIds: string[];
    parentIds: string[];
    childIds: string[];
    messageIds: number[];
    earliestAt: Date | null;
    latestAt: Date | null;
    createdAt: Date;
  };
}

export interface GrepInput {
  query: string;
  mode: "regex" | "full_text";
  scope: "messages" | "summaries" | "both";
  conversationId?: number;
  limit?: number;
}

export interface GrepResult {
  messages: Awaited<ReturnType<ConversationStore["searchMessages"]>>;
  summaries: Awaited<ReturnType<SummaryStore["searchSummaries"]>>;
  totalMatches: number;
}

export interface ExpandInput {
  summaryId: string;
  depth?: number;
  includeMessages?: boolean;
  tokenCap?: number;
}

export interface ExpandResult {
  children: Array<{ summaryId: string; kind: "leaf" | "condensed"; content: string; tokenCount: number }>;
  messages: Array<{ messageId: number; role: string; content: string; tokenCount: number }>;
  estimatedTokens: number;
  truncated: boolean;
}

export class RetrievalEngine {
  constructor(private conversationStore: ConversationStore, private summaryStore: SummaryStore) {}

  async describe(id: string): Promise<DescribeResult | null> {
    if (!id.startsWith("sum_")) {
      return null;
    }
    const summary = await this.summaryStore.getSummary(id);
    if (!summary) return null;
    const [parents, children, messageIds] = await Promise.all([
      this.summaryStore.getSummaryParents(id),
      this.summaryStore.getSummaryChildren(id),
      this.summaryStore.getSummaryMessages(id),
    ]);
    return {
      id,
      type: "summary",
      summary: {
        conversationId: summary.conversationId,
        kind: summary.kind,
        content: summary.content,
        depth: summary.depth,
        tokenCount: summary.tokenCount,
        descendantCount: summary.descendantCount,
        descendantTokenCount: summary.descendantTokenCount,
        sourceMessageTokenCount: summary.sourceMessageTokenCount,
        fileIds: summary.fileIds,
        parentIds: parents.map((parent) => parent.summaryId),
        childIds: children.map((child) => child.summaryId),
        messageIds,
        earliestAt: summary.earliestAt,
        latestAt: summary.latestAt,
        createdAt: summary.createdAt,
      },
    };
  }

  async grep(input: GrepInput): Promise<GrepResult> {
    let messages = [] as Awaited<ReturnType<ConversationStore["searchMessages"]>>;
    let summaries = [] as Awaited<ReturnType<SummaryStore["searchSummaries"]>>;
    if (input.scope === "messages") {
      messages = await this.conversationStore.searchMessages(input);
    } else if (input.scope === "summaries") {
      summaries = await this.summaryStore.searchSummaries(input);
    } else {
      [messages, summaries] = await Promise.all([
        this.conversationStore.searchMessages(input),
        this.summaryStore.searchSummaries(input),
      ]);
    }
    return { messages, summaries, totalMatches: messages.length + summaries.length };
  }

  async expand(input: ExpandInput): Promise<ExpandResult> {
    const result: ExpandResult = { children: [], messages: [], estimatedTokens: 0, truncated: false };
    await this.expandRecursive(input.summaryId, input.depth ?? 1, input.includeMessages ?? false, input.tokenCap ?? Number.POSITIVE_INFINITY, result);
    return result;
  }

  private async expandRecursive(summaryId: string, depth: number, includeMessages: boolean, tokenCap: number, result: ExpandResult): Promise<void> {
    if (depth <= 0 || result.truncated) return;
    const summary = await this.summaryStore.getSummary(summaryId);
    if (!summary) return;
    if (summary.kind === "condensed") {
      const parents = await this.summaryStore.getSummaryParents(summaryId);
      for (const parent of parents) {
        if (result.estimatedTokens + parent.tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }
        result.children.push({ summaryId: parent.summaryId, kind: parent.kind, content: parent.content, tokenCount: parent.tokenCount });
        result.estimatedTokens += parent.tokenCount;
        if (depth > 1) {
          await this.expandRecursive(parent.summaryId, depth - 1, includeMessages, tokenCap, result);
        }
      }
      return;
    }
    if (!includeMessages) return;
    const messageIds = await this.summaryStore.getSummaryMessages(summaryId);
    for (const messageId of messageIds) {
      const message = await this.conversationStore.getMessageById(messageId);
      if (!message) continue;
      const tokenCount = message.tokenCount || estimateTokens(message.content);
      if (result.estimatedTokens + tokenCount > tokenCap) {
        result.truncated = true;
        break;
      }
      result.messages.push({ messageId: message.messageId, role: message.role, content: message.content, tokenCount });
      result.estimatedTokens += tokenCount;
    }
  }
}
