import { estimateTokens } from "./estimate-tokens";
import { sanitizeToolUseResultPairing } from "./transcript-repair";
import type { ConversationStore, MessagePartRecord, MessageRole } from "./conversation-store";
import type { ContextItemRecord, SummaryRecord, SummaryStore } from "./summary-store";

type AgentMessage = {
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  usage?: unknown;
  attachments?: unknown[];
  meta?: unknown;
  stopReason?: string;
};

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

type SummaryPromptSignal = Pick<SummaryRecord, "kind" | "depth" | "descendantCount">;

function buildSystemPromptAddition(summarySignals: SummaryPromptSignal[]): string | undefined {
  if (summarySignals.length === 0) {
    return undefined;
  }

  const maxDepth = summarySignals.reduce((deepest, signal) => Math.max(deepest, signal.depth), 0);
  const condensedCount = summarySignals.filter((signal) => signal.kind === "condensed").length;
  const heavilyCompacted = maxDepth >= 2 || condensedCount >= 2;

  const sections: string[] = [];
  sections.push(
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
  );

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

function parseJson(value: string | null): unknown {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function getOriginalRole(parts: MessagePartRecord[]): string | null {
  for (const part of parts) {
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
      continue;
    }
    const role = (decoded as { originalRole?: unknown }).originalRole;
    if (typeof role === "string" && role.length > 0) {
      return role;
    }
  }
  return null;
}

function getMessageMetadata(parts: MessagePartRecord[]): { attachments?: unknown[]; meta?: unknown } {
  for (const part of parts) {
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
      continue;
    }
    const record = decoded as { attachments?: unknown; meta?: unknown };
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

function getPartMetadata(part: MessagePartRecord): { originalRole?: string; rawType?: string; raw?: unknown } {
  const decoded = parseJson(part.metadata);
  if (!decoded || typeof decoded !== "object") {
    return {};
  }

  const record = decoded as { originalRole?: unknown; rawType?: unknown; raw?: unknown };
  return {
    originalRole: typeof record.originalRole === "string" && record.originalRole.length > 0 ? record.originalRole : undefined,
    rawType: typeof record.rawType === "string" && record.rawType.length > 0 ? record.rawType : undefined,
    raw: record.raw,
  };
}

function parseStoredValue(value: string | null): unknown {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = parseJson(value);
  return parsed !== undefined ? parsed : value;
}

function reasoningBlockFromPart(part: MessagePartRecord, rawType?: string): unknown {
  const type = rawType === "thinking" ? "thinking" : "reasoning";
  if (typeof part.textContent === "string" && part.textContent.length > 0) {
    return type === "thinking" ? { type, thinking: part.textContent } : { type, text: part.textContent };
  }
  return { type };
}

function tryRestoreOpenAIReasoning(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.type !== "thinking") {
    return null;
  }
  const sig = raw.thinkingSignature;
  if (typeof sig !== "string" || !sig.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(sig) as Record<string, unknown>;
    if (parsed.type === "reasoning" && typeof parsed.id === "string") {
      return parsed;
    }
  } catch {}
  return null;
}

function toolCallBlockFromPart(part: MessagePartRecord, rawType?: string): unknown {
  const type =
    rawType === "function_call" ||
    rawType === "functionCall" ||
    rawType === "tool_use" ||
    rawType === "tool-use" ||
    rawType === "toolUse" ||
    rawType === "toolCall"
      ? rawType
      : "toolCall";
  const input = parseStoredValue(part.toolInput);
  const block: Record<string, unknown> = { type };

  if (type === "function_call") {
    if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
      block.call_id = part.toolCallId;
    }
    if (typeof part.toolName === "string" && part.toolName.length > 0) {
      block.name = part.toolName;
    }
    if (input !== undefined) {
      block.arguments = input;
    }
    return block;
  }

  block.id = typeof part.toolCallId === "string" && part.toolCallId.length > 0 ? part.toolCallId : `toolu_lcm_${part.partId ?? "unknown"}`;
  if (typeof part.toolName === "string" && part.toolName.length > 0) {
    block.name = part.toolName;
  }
  if (input !== undefined) {
    if (type === "functionCall" || type === "toolCall") {
      block.arguments = input;
    } else {
      block.input = input;
    }
  }
  return block;
}

function toolResultBlockFromPart(part: MessagePartRecord, rawType?: string, raw?: Record<string, unknown>): unknown {
  const type = rawType === "function_call_output" || rawType === "toolResult" || rawType === "tool_result" ? rawType : "tool_result";
  const output = parseStoredValue(part.toolOutput);
  const block: Record<string, unknown> = { type };

  if (typeof part.toolName === "string" && part.toolName.length > 0) {
    block.name = part.toolName;
  }

  if (output !== undefined) {
    block.output = output;
  } else if (typeof part.textContent === "string") {
    block.output = part.textContent;
  } else if (raw && raw.output !== undefined) {
    block.output = raw.output;
  } else if (raw && raw.content !== undefined) {
    block.content = raw.content;
  } else {
    block.output = "";
  }

  if (raw && typeof raw.is_error === "boolean") {
    block.is_error = raw.is_error;
  } else if (raw && typeof raw.isError === "boolean") {
    block.isError = raw.isError;
  }

  if (type === "function_call_output") {
    if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
      block.call_id = part.toolCallId;
    }
    return block;
  }

  if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
    block.tool_use_id = part.toolCallId;
  }
  return block;
}

function toRuntimeRole(dbRole: MessageRole, parts: MessagePartRecord[]): AgentMessage["role"] {
  const originalRole = getOriginalRole(parts);
  if (originalRole === "toolResult") {
    return "toolResult";
  }
  if (originalRole === "assistant") {
    return "assistant";
  }
  if (originalRole === "user") {
    return "user";
  }
  if (originalRole === "system") {
    return "user";
  }
  if (dbRole === "tool") {
    return "toolResult";
  }
  if (dbRole === "assistant") {
    return "assistant";
  }
  return "user";
}

function blockFromPart(part: MessagePartRecord): unknown {
  const metadata = getPartMetadata(part);
  if (metadata.raw && typeof metadata.raw === "object") {
    const restored = tryRestoreOpenAIReasoning(metadata.raw as Record<string, unknown>);
    if (restored) {
      return restored;
    }

    const rawType = (metadata.raw as Record<string, unknown>).type as string | undefined;
    const isToolBlock =
      rawType === "toolCall" ||
      rawType === "tool_use" ||
      rawType === "tool-use" ||
      rawType === "toolUse" ||
      rawType === "functionCall" ||
      rawType === "function_call" ||
      rawType === "function_call_output" ||
      rawType === "toolResult" ||
      rawType === "tool_result";
    if (isToolBlock) {
      const rawRecord = metadata.raw as Record<string, unknown>;
      const rawToolCallId =
        typeof rawRecord.id === "string" && rawRecord.id.length > 0
          ? rawRecord.id
          : typeof rawRecord.call_id === "string" && rawRecord.call_id.length > 0
            ? rawRecord.call_id
            : undefined;
      if (rawToolCallId && (!part.toolCallId || part.toolCallId.length === 0)) {
        part.toolCallId = rawToolCallId;
      }
      if (typeof rawRecord.name === "string" && rawRecord.name.length > 0 && (!part.toolName || part.toolName.length === 0)) {
        part.toolName = rawRecord.name;
      }
      if (part.toolInput == null || part.toolInput === "") {
        const rawArgs = rawRecord.arguments ?? rawRecord.input;
        if (rawArgs !== undefined) {
          part.toolInput = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
        }
      }
    }
  }

  if (part.partType === "reasoning") {
    return reasoningBlockFromPart(part, metadata.rawType);
  }
  if (part.partType === "tool") {
    if (metadata.originalRole === "toolResult" || metadata.rawType === "function_call_output") {
      return toolResultBlockFromPart(part, metadata.rawType, metadata.raw && typeof metadata.raw === "object" ? metadata.raw as Record<string, unknown> : undefined);
    }
    return toolCallBlockFromPart(part, metadata.rawType);
  }
  if (metadata.rawType === "function_call" || metadata.rawType === "functionCall" || metadata.rawType === "tool_use" || metadata.rawType === "tool-use" || metadata.rawType === "toolUse" || metadata.rawType === "toolCall") {
    return toolCallBlockFromPart(part, metadata.rawType);
  }
  if (metadata.rawType === "function_call_output" || metadata.rawType === "tool_result" || metadata.rawType === "toolResult") {
    return toolResultBlockFromPart(part, metadata.rawType, metadata.raw && typeof metadata.raw === "object" ? metadata.raw as Record<string, unknown> : undefined);
  }
  if (part.partType === "text") {
    return { type: "text", text: part.textContent ?? "" };
  }
  if (typeof part.textContent === "string" && part.textContent.length > 0) {
    return { type: "text", text: part.textContent };
  }

  const decodedFallback = parseJson(part.metadata);
  if (decodedFallback && typeof decodedFallback === "object") {
    return { type: "text", text: JSON.stringify(decodedFallback) };
  }
  return { type: "text", text: "" };
}

function contentFromParts(parts: MessagePartRecord[], role: AgentMessage["role"], fallbackContent: string): unknown {
  if (parts.length === 0) {
    if (role === "assistant") {
      return fallbackContent ? [{ type: "text", text: fallbackContent }] : [];
    }
    if (role === "toolResult") {
      return [{ type: "text", text: fallbackContent }];
    }
    return fallbackContent;
  }

  const blocks = parts.map(blockFromPart);
  if (
    role === "user" &&
    blocks.length === 1 &&
    blocks[0] &&
    typeof blocks[0] === "object" &&
    (blocks[0] as { type?: unknown }).type === "text" &&
    typeof (blocks[0] as { text?: unknown }).text === "string"
  ) {
    return (blocks[0] as { text: string }).text;
  }
  return blocks;
}

function pickToolCallId(parts: MessagePartRecord[]): string | undefined {
  for (const part of parts) {
    if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
      return part.toolCallId;
    }
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
      continue;
    }
    const metadataToolCallId = (decoded as { toolCallId?: unknown }).toolCallId;
    if (typeof metadataToolCallId === "string" && metadataToolCallId.length > 0) {
      return metadataToolCallId;
    }
    const raw = (decoded as { raw?: unknown }).raw;
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const maybe = (raw as { toolCallId?: unknown; tool_call_id?: unknown }).toolCallId;
    if (typeof maybe === "string" && maybe.length > 0) {
      return maybe;
    }
    const maybeSnake = (raw as { tool_call_id?: unknown }).tool_call_id;
    if (typeof maybeSnake === "string" && maybeSnake.length > 0) {
      return maybeSnake;
    }
  }
  return undefined;
}

function pickToolName(parts: MessagePartRecord[]): string | undefined {
  for (const part of parts) {
    if (typeof part.toolName === "string" && part.toolName.length > 0) {
      return part.toolName;
    }
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
      continue;
    }
    const metadataToolName = (decoded as { toolName?: unknown }).toolName;
    if (typeof metadataToolName === "string" && metadataToolName.length > 0) {
      return metadataToolName;
    }
    const raw = (decoded as { raw?: unknown }).raw;
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const maybe = (raw as { name?: unknown }).name;
    if (typeof maybe === "string" && maybe.length > 0) {
      return maybe;
    }
    const maybeCamel = (raw as { toolName?: unknown }).toolName;
    if (typeof maybeCamel === "string" && maybeCamel.length > 0) {
      return maybeCamel;
    }
  }
  return undefined;
}

function pickToolIsError(parts: MessagePartRecord[]): boolean | undefined {
  for (const part of parts) {
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
      continue;
    }
    const metadataIsError = (decoded as { isError?: unknown }).isError;
    if (typeof metadataIsError === "boolean") {
      return metadataIsError;
    }
  }
  return undefined;
}

function formatDateForAttribute(date: Date, timezone?: string): string {
  const tz = timezone ?? "UTC";
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const p = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  } catch {
    return date.toISOString();
  }
}

async function formatSummaryContent(summary: SummaryRecord, summaryStore: SummaryStore, timezone?: string): Promise<string> {
  const attributes = [
    `id="${summary.summaryId}"`,
    `kind="${summary.kind}"`,
    `depth="${summary.depth}"`,
    `descendant_count="${summary.descendantCount}"`,
  ];
  if (summary.earliestAt) {
    attributes.push(`earliest_at="${formatDateForAttribute(summary.earliestAt, timezone)}"`);
  }
  if (summary.latestAt) {
    attributes.push(`latest_at="${formatDateForAttribute(summary.latestAt, timezone)}"`);
  }

  const lines: string[] = [];
  lines.push(`<summary ${attributes.join(" ")}>`);
  if (summary.kind === "condensed") {
    const parents = await summaryStore.getSummaryParents(summary.summaryId);
    if (parents.length > 0) {
      lines.push("  <parents>");
      for (const parent of parents) {
        lines.push(`    <summary_ref id="${parent.summaryId}" />`);
      }
      lines.push("  </parents>");
    }
  }
  lines.push("  <content>");
  lines.push(summary.content);
  lines.push("  </content>");
  lines.push("</summary>");
  return lines.join("\n");
}

interface ResolvedItem {
  ordinal: number;
  message: AgentMessage;
  tokens: number;
  isMessage: boolean;
  summarySignal?: SummaryPromptSignal;
}

export class ContextAssembler {
  constructor(private conversationStore: ConversationStore, private summaryStore: SummaryStore, private timezone?: string) {}

  async assemble(input: AssembleContextInput): Promise<AssembleContextResult> {
    const freshTailCount = input.freshTailCount ?? 8;
    const contextItems = await this.summaryStore.getContextItems(input.conversationId);

    if (contextItems.length === 0) {
      return {
        messages: [],
        estimatedTokens: 0,
        stats: { rawMessageCount: 0, summaryCount: 0, totalContextItems: 0 },
      };
    }

    const resolved = await this.resolveItems(contextItems);
    let rawMessageCount = 0;
    let summaryCount = 0;
    const summarySignals: SummaryPromptSignal[] = [];
    for (const item of resolved) {
      if (item.isMessage) {
        rawMessageCount += 1;
      } else {
        summaryCount += 1;
        if (item.summarySignal) {
          summarySignals.push(item.summarySignal);
        }
      }
    }

    const systemPromptAddition = buildSystemPromptAddition(summarySignals);
    const tailStart = Math.max(0, resolved.length - freshTailCount);
    const freshTail = resolved.slice(tailStart);
    const evictable = resolved.slice(0, tailStart);
    const tailTokens = freshTail.reduce((sum, item) => sum + item.tokens, 0);
    const remainingBudget = Math.max(0, input.tokenBudget - tailTokens);

    const selected: ResolvedItem[] = [];
    let evictableTokens = 0;
    const evictableTotalTokens = evictable.reduce((sum, item) => sum + item.tokens, 0);
    if (evictableTotalTokens <= remainingBudget) {
      selected.push(...evictable);
      evictableTokens = evictableTotalTokens;
    } else {
      const kept: ResolvedItem[] = [];
      let accum = 0;
      for (let i = evictable.length - 1; i >= 0; i -= 1) {
        const item = evictable[i]!;
        if (accum + item.tokens <= remainingBudget) {
          kept.push(item);
          accum += item.tokens;
        } else {
          break;
        }
      }
      kept.reverse();
      selected.push(...kept);
      evictableTokens = accum;
    }

    selected.push(...freshTail);
    const estimatedTokens = evictableTokens + tailTokens;
    const rawMessages = selected.map((item) => item.message);
    for (let i = 0; i < rawMessages.length; i += 1) {
      const message = rawMessages[i];
      if (message.role === "assistant" && typeof message.content === "string") {
        rawMessages[i] = {
          ...message,
          content: [{ type: "text", text: message.content }],
        };
      }
    }

    return {
      messages: sanitizeToolUseResultPairing(rawMessages) as AgentMessage[],
      estimatedTokens,
      systemPromptAddition,
      stats: {
        rawMessageCount,
        summaryCount,
        totalContextItems: resolved.length,
      },
    };
  }

  private async resolveItems(contextItems: ContextItemRecord[]): Promise<ResolvedItem[]> {
    const resolved: ResolvedItem[] = [];
    for (const item of contextItems) {
      const result = await this.resolveItem(item);
      if (result) {
        resolved.push(result);
      }
    }
    return resolved;
  }

  private async resolveItem(item: ContextItemRecord): Promise<ResolvedItem | null> {
    if (item.itemType === "message" && item.messageId != null) {
      return this.resolveMessageItem(item);
    }
    if (item.itemType === "summary" && item.summaryId != null) {
      return this.resolveSummaryItem(item);
    }
    return null;
  }

  private async resolveMessageItem(item: ContextItemRecord): Promise<ResolvedItem | null> {
    const msg = await this.conversationStore.getMessageById(item.messageId!);
    if (!msg) {
      return null;
    }

    const parts = await this.conversationStore.getMessageParts(msg.messageId);
    if (msg.role === "assistant" && !msg.content.trim() && parts.length === 0) {
      return null;
    }

    const messageMetadata = getMessageMetadata(parts);
    const roleFromStore = toRuntimeRole(msg.role, parts);
    const isToolResult = roleFromStore === "toolResult";
    const toolCallId = isToolResult ? pickToolCallId(parts) : undefined;
    const toolName = isToolResult ? (pickToolName(parts) ?? "unknown") : undefined;
    const toolIsError = isToolResult ? pickToolIsError(parts) : undefined;
    const role: AgentMessage["role"] = isToolResult && !toolCallId ? "assistant" : roleFromStore;
    const content = contentFromParts(parts, role, msg.content);
    const contentText = typeof content === "string" ? content : (JSON.stringify(content) ?? msg.content);
    const tokenCount = estimateTokens(contentText);

    return {
      ordinal: item.ordinal,
      message:
        role === "assistant"
          ? {
              role,
              content,
              ...(messageMetadata.attachments ? { attachments: messageMetadata.attachments } : {}),
              ...(typeof messageMetadata.meta !== "undefined" ? { meta: messageMetadata.meta } : {}),
              usage: {
                input: 0,
                output: tokenCount,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: tokenCount,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            }
          : {
              role,
              content,
              ...(messageMetadata.attachments ? { attachments: messageMetadata.attachments } : {}),
              ...(typeof messageMetadata.meta !== "undefined" ? { meta: messageMetadata.meta } : {}),
              ...(toolCallId ? { toolCallId } : {}),
              ...(toolName ? { toolName } : {}),
              ...(role === "toolResult" && toolIsError !== undefined ? { isError: toolIsError } : {}),
            },
      tokens: tokenCount,
      isMessage: true,
    };
  }

  private async resolveSummaryItem(item: ContextItemRecord): Promise<ResolvedItem | null> {
    const summary = await this.summaryStore.getSummary(item.summaryId!);
    if (!summary) {
      return null;
    }

    const content = await formatSummaryContent(summary, this.summaryStore, this.timezone);
    const tokens = estimateTokens(content);

    return {
      ordinal: item.ordinal,
      message: { role: "user", content },
      tokens,
      isMessage: false,
      summarySignal: {
        kind: summary.kind,
        depth: summary.depth,
        descendantCount: summary.descendantCount,
      },
    };
  }
}
