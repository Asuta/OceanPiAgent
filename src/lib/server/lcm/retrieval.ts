import { estimateTokens } from "./estimate-tokens";
import type { ConversationStore, MessageSearchResult } from "./conversation-store";
import type { SummaryStore, SummarySearchResult } from "./summary-store";

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
    subtree: Array<{
      summaryId: string;
      parentSummaryId: string | null;
      depthFromRoot: number;
      kind: "leaf" | "condensed";
      depth: number;
      tokenCount: number;
      descendantCount: number;
      descendantTokenCount: number;
      sourceMessageTokenCount: number;
      earliestAt: Date | null;
      latestAt: Date | null;
      childCount: number;
      path: string;
    }>;
    earliestAt: Date | null;
    latestAt: Date | null;
    createdAt: Date;
  };
  file?: {
    conversationId: number;
    fileName: string | null;
    mimeType: string | null;
    byteSize: number | null;
    storageUri: string;
    explorationSummary: string | null;
    createdAt: Date;
  };
}

export interface GrepInput {
  query: string;
  mode: "regex" | "full_text";
  scope: "messages" | "summaries" | "both";
  conversationId?: number;
  since?: Date;
  before?: Date;
  limit?: number;
}

export interface GrepResult {
  messages: MessageSearchResult[];
  summaries: SummarySearchResult[];
  totalMatches: number;
}

export interface ExpandInput {
  summaryId: string;
  depth?: number;
  includeMessages?: boolean;
  tokenCap?: number;
}

export interface ExpandResult {
  children: Array<{
    summaryId: string;
    kind: "leaf" | "condensed";
    content: string;
    tokenCount: number;
  }>;
  messages: Array<{
    messageId: number;
    role: string;
    content: string;
    tokenCount: number;
  }>;
  estimatedTokens: number;
  truncated: boolean;
}

export class RetrievalEngine {
  constructor(private conversationStore: ConversationStore, private summaryStore: SummaryStore) {}

  async describe(id: string): Promise<DescribeResult | null> {
    if (id.startsWith("sum_")) {
      return this.describeSummary(id);
    }
    if (id.startsWith("file_")) {
      return this.describeFile(id);
    }
    return null;
  }

  private async describeSummary(id: string): Promise<DescribeResult | null> {
    const summary = await this.summaryStore.getSummary(id);
    if (!summary) {
      return null;
    }

    const [parents, children, messageIds, subtree] = await Promise.all([
      this.summaryStore.getSummaryParents(id),
      this.summaryStore.getSummaryChildren(id),
      this.summaryStore.getSummaryMessages(id),
      this.summaryStore.getSummarySubtree(id),
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
        subtree: subtree.map((node) => ({
          summaryId: node.summaryId,
          parentSummaryId: node.parentSummaryId,
          depthFromRoot: node.depthFromRoot,
          kind: node.kind,
          depth: node.depth,
          tokenCount: node.tokenCount,
          descendantCount: node.descendantCount,
          descendantTokenCount: node.descendantTokenCount,
          sourceMessageTokenCount: node.sourceMessageTokenCount,
          earliestAt: node.earliestAt,
          latestAt: node.latestAt,
          childCount: node.childCount,
          path: node.path,
        })),
        earliestAt: summary.earliestAt,
        latestAt: summary.latestAt,
        createdAt: summary.createdAt,
      },
    };
  }

  private async describeFile(id: string): Promise<DescribeResult | null> {
    const file = await this.summaryStore.getLargeFile(id);
    if (!file) {
      return null;
    }

    return {
      id,
      type: "file",
      file: {
        conversationId: file.conversationId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        storageUri: file.storageUri,
        explorationSummary: file.explorationSummary,
        createdAt: file.createdAt,
      },
    };
  }

  async grep(input: GrepInput): Promise<GrepResult> {
    const { query, mode, scope, conversationId, since, before, limit } = input;
    const searchInput = { query, mode, conversationId, since, before, limit };

    let messages: MessageSearchResult[] = [];
    let summaries: SummarySearchResult[] = [];

    if (scope === "messages") {
      messages = await this.conversationStore.searchMessages(searchInput);
    } else if (scope === "summaries") {
      summaries = await this.summaryStore.searchSummaries(searchInput);
    } else {
      [messages, summaries] = await Promise.all([
        this.conversationStore.searchMessages(searchInput),
        this.summaryStore.searchSummaries(searchInput),
      ]);
    }

    messages.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    summaries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return {
      messages,
      summaries,
      totalMatches: messages.length + summaries.length,
    };
  }

  async expand(input: ExpandInput): Promise<ExpandResult> {
    const depth = input.depth ?? 1;
    const includeMessages = input.includeMessages ?? false;
    const tokenCap = input.tokenCap ?? Number.POSITIVE_INFINITY;

    const result: ExpandResult = {
      children: [],
      messages: [],
      estimatedTokens: 0,
      truncated: false,
    };

    await this.expandRecursive(input.summaryId, depth, includeMessages, tokenCap, result);
    return result;
  }

  private async expandRecursive(summaryId: string, depth: number, includeMessages: boolean, tokenCap: number, result: ExpandResult): Promise<void> {
    if (depth <= 0 || result.truncated) {
      return;
    }

    const summary = await this.summaryStore.getSummary(summaryId);
    if (!summary) {
      return;
    }

    if (summary.kind === "condensed") {
      const children = await this.summaryStore.getSummaryParents(summaryId);

      for (const child of children) {
        if (result.truncated) {
          break;
        }
        if (result.estimatedTokens + child.tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }

        result.children.push({
          summaryId: child.summaryId,
          kind: child.kind,
          content: child.content,
          tokenCount: child.tokenCount,
        });
        result.estimatedTokens += child.tokenCount;

        if (depth > 1) {
          await this.expandRecursive(child.summaryId, depth - 1, includeMessages, tokenCap, result);
        }
      }
      return;
    }

    if (!includeMessages) {
      return;
    }

    const messageIds = await this.summaryStore.getSummaryMessages(summaryId);
    for (const msgId of messageIds) {
      if (result.truncated) {
        break;
      }

      const msg = await this.conversationStore.getMessageById(msgId);
      if (!msg) {
        continue;
      }

      const tokenCount = msg.tokenCount || estimateTokens(msg.content);
      if (result.estimatedTokens + tokenCount > tokenCap) {
        result.truncated = true;
        break;
      }

      result.messages.push({
        messageId: msg.messageId,
        role: msg.role,
        content: msg.content,
        tokenCount,
      });
      result.estimatedTokens += tokenCount;
    }
  }
}
