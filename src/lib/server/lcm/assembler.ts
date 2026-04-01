import { estimateTokens } from "./estimate-tokens";
import type { ConversationStore, MessagePartRecord, MessageRole } from "./conversation-store";
import type { ContextItemRecord, SummaryRecord, SummaryStore } from "./summary-store";

type AgentMessage = { role: "user" | "assistant" | "toolResult"; content: unknown; toolCallId?: string; toolName?: string; isError?: boolean; usage?: unknown; attachments?: unknown[]; meta?: unknown };

export interface AssembleContextInput {
  conversationId: number;
  tokenBudget: number;
  freshTailCount?: number;
}

export interface AssembleContextResult {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
  stats: {
    rawMessageCount: number;
    summaryCount: number;
    totalContextItems: number;
  };
}

function parseJson(value: string | null): unknown {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function getOriginalRole(parts: MessagePartRecord[]): string | null {
  for (const part of parts) {
    const meta = parseJson(part.metadata);
    if (meta && typeof meta === "object" && typeof (meta as { originalRole?: unknown }).originalRole === "string") {
      return (meta as { originalRole: string }).originalRole;
    }
  }
  return null;
}

function getMessageMetadata(parts: MessagePartRecord[]): { attachments?: unknown[]; meta?: unknown } {
  for (const part of parts) {
    const meta = parseJson(part.metadata);
    if (!meta || typeof meta !== "object") {
      continue;
    }
    const record = meta as { attachments?: unknown; meta?: unknown };
    const result: { attachments?: unknown[]; meta?: unknown } = {};
    if (Array.isArray(record.attachments)) {
      result.attachments = record.attachments;
    }
    if (typeof record.meta !== "undefined") {
      result.meta = record.meta;
    }
    if (result.attachments || typeof result.meta !== "undefined") {
      return result;
    }
  }
  return {};
}

function toRuntimeRole(dbRole: MessageRole, parts: MessagePartRecord[]): AgentMessage["role"] {
  const originalRole = getOriginalRole(parts);
  if (originalRole === "toolResult") return "toolResult";
  if (originalRole === "assistant") return "assistant";
  if (originalRole === "user") return "user";
  if (dbRole === "tool") return "toolResult";
  if (dbRole === "assistant") return "assistant";
  return "user";
}

function blockFromPart(part: MessagePartRecord): unknown {
  if (part.partType === "tool") {
    const raw = parseJson(part.metadata);
    const originalRole = raw && typeof raw === "object" ? (raw as { originalRole?: unknown }).originalRole : undefined;
    if (originalRole === "toolResult") {
      return {
        type: "tool_result",
        tool_use_id: part.toolCallId ?? undefined,
        name: part.toolName ?? undefined,
        output: part.toolOutput ? parseJson(part.toolOutput) ?? part.toolOutput : (part.textContent ?? ""),
      };
    }
    return {
      type: "toolCall",
      id: part.toolCallId ?? `toolu_lcm_${part.partId}`,
      name: part.toolName ?? undefined,
      arguments: part.toolInput ? parseJson(part.toolInput) ?? part.toolInput : undefined,
    };
  }
  if (part.partType === "reasoning") {
    return { type: "reasoning", text: part.textContent ?? "" };
  }
  return { type: "text", text: part.textContent ?? "" };
}

function contentFromParts(parts: MessagePartRecord[], role: AgentMessage["role"], fallback: string): unknown {
  if (parts.length === 0) {
    return role === "user" ? fallback : [{ type: "text", text: fallback }];
  }
  const blocks = parts.map(blockFromPart);
  if (role === "user" && blocks.length === 1 && typeof blocks[0] === "object" && blocks[0] && (blocks[0] as { type?: unknown }).type === "text") {
    return (blocks[0] as { text: string }).text;
  }
  return blocks;
}

function buildSystemPromptAddition(summarySignals: Array<Pick<SummaryRecord, "kind" | "depth" | "descendantCount">>): string | undefined {
  if (summarySignals.length === 0) {
    return undefined;
  }
  const maxDepth = summarySignals.reduce((max, signal) => Math.max(max, signal.depth), 0);
  const condensedCount = summarySignals.filter((signal) => signal.kind === "condensed").length;
  const heavilyCompacted = maxDepth >= 2 || condensedCount >= 2;
  const sections = [
    "## LCM Recall",
    "",
    "Summaries above are compressed context and map to older details rather than replacing them.",
    "",
    "Recall priority: use memory_search first for compacted history, then inspect promising summary handles before answering from them.",
    "",
    "Tool escalation:",
    "1. memory_search",
    "2. memory_describe",
    "3. memory_expand",
    "",
    "When a summary footer or its content suggests hidden specifics, expand before making exact claims.",
  ];
  if (heavilyCompacted) {
    sections.push(
      "",
      "Deeply compacted context is present. Expand before asserting exact commands, SHAs, file paths, timestamps, config values, or causal chains.",
    );
  } else {
    sections.push(
      "",
      "When the user asks for an exact earlier value and it is not verbatim in the visible summary, expand before answering.",
    );
  }
  return sections.join("\n");
}

interface ResolvedItem {
  ordinal: number;
  message: AgentMessage;
  tokens: number;
  isMessage: boolean;
  summarySignal?: Pick<SummaryRecord, "kind" | "depth" | "descendantCount">;
}

export class ContextAssembler {
  constructor(private conversationStore: ConversationStore, private summaryStore: SummaryStore) {}

  async assemble(input: AssembleContextInput): Promise<AssembleContextResult> {
    const freshTailCount = input.freshTailCount ?? 8;
    const contextItems = await this.summaryStore.getContextItems(input.conversationId);
    const resolved = (await Promise.all(contextItems.map((item) => this.resolveItem(item)))).filter((item): item is ResolvedItem => Boolean(item));

    const summarySignals = resolved.filter((item) => !item.isMessage && item.summarySignal).map((item) => item.summarySignal as Pick<SummaryRecord, "kind" | "depth" | "descendantCount">);
    const systemPromptAddition = buildSystemPromptAddition(summarySignals);
    const tailStart = Math.max(0, resolved.length - freshTailCount);
    const freshTail = resolved.slice(tailStart);
    const evictable = resolved.slice(0, tailStart);
    const tailTokens = freshTail.reduce((sum, item) => sum + item.tokens, 0);
    const remainingBudget = Math.max(0, input.tokenBudget - tailTokens);
    const keptPrefix: ResolvedItem[] = [];
    let accum = 0;
    for (let i = evictable.length - 1; i >= 0; i -= 1) {
      const item = evictable[i]!;
      if (accum + item.tokens > remainingBudget) {
        break;
      }
      keptPrefix.push(item);
      accum += item.tokens;
    }
    keptPrefix.reverse();
    const selected = [...keptPrefix, ...freshTail];
    return {
      messages: selected.map((item) => item.message),
      estimatedTokens: selected.reduce((sum, item) => sum + item.tokens, 0),
      systemPromptAddition,
      stats: {
        rawMessageCount: resolved.filter((item) => item.isMessage).length,
        summaryCount: resolved.filter((item) => !item.isMessage).length,
        totalContextItems: resolved.length,
      },
    };
  }

  private async resolveItem(item: ContextItemRecord): Promise<ResolvedItem | null> {
    if (item.itemType === "message" && item.messageId != null) {
      const message = await this.conversationStore.getMessageById(item.messageId);
      if (!message) return null;
      const parts = await this.conversationStore.getMessageParts(message.messageId);
      const role = toRuntimeRole(message.role, parts);
      const messageMetadata = getMessageMetadata(parts);
      const content = contentFromParts(parts, role, message.content);
      const tokenText = typeof content === "string" ? content : JSON.stringify(content);
      return {
        ordinal: item.ordinal,
        message: role === "assistant"
          ? { role, content, ...(messageMetadata.attachments ? { attachments: messageMetadata.attachments } : {}), ...(typeof messageMetadata.meta !== "undefined" ? { meta: messageMetadata.meta } : {}), usage: { input: 0, output: estimateTokens(tokenText), cacheRead: 0, cacheWrite: 0, totalTokens: estimateTokens(tokenText), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
          : { role, content, ...(messageMetadata.attachments ? { attachments: messageMetadata.attachments } : {}), ...(typeof messageMetadata.meta !== "undefined" ? { meta: messageMetadata.meta } : {}), ...(role === "toolResult" && parts[0]?.toolCallId ? { toolCallId: parts[0].toolCallId } : {}), ...(role === "toolResult" && parts[0]?.toolName ? { toolName: parts[0].toolName } : {}) },
        tokens: estimateTokens(tokenText),
        isMessage: true,
      };
    }
    if (item.itemType === "summary" && item.summaryId != null) {
      const summary = await this.summaryStore.getSummary(item.summaryId);
      if (!summary) return null;
      const content = [`<summary id="${summary.summaryId}" kind="${summary.kind}" depth="${summary.depth}" descendant_count="${summary.descendantCount}">`, "<content>", summary.content, "</content>", "</summary>"].join("\n");
      return {
        ordinal: item.ordinal,
        message: { role: "user", content },
        tokens: estimateTokens(content),
        isMessage: false,
        summarySignal: { kind: summary.kind, depth: summary.depth, descendantCount: summary.descendantCount },
      };
    }
    return null;
  }
}
