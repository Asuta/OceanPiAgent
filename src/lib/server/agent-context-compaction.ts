import { appendAgentCompactionMemory } from "./agent-memory-store";
import {
  getAgentContextStateSnapshot,
  insertAgentContextSummary,
  replaceAgentContextRangeWithSummary,
  type AgentContextItemRecord,
} from "./agent-context-store";
import { generateCompactionSummary } from "./agent-compaction";
import type { PersistedVisibleMessage } from "./agent-runtime-store";
import type { RoomAgentId } from "@/lib/chat/types";
import { createUuid } from "@/lib/utils/uuid";

export interface AgentContextCompactionResult {
  compacted: boolean;
  summaryId?: string;
  summaryKind?: "leaf" | "condensed";
  summary?: string;
  prunedItems: number;
  keptItems: number;
  charsBefore: number;
  charsAfter: number;
}

const AUTO_COMPACT_CHAR_THRESHOLD = 26_000;
const KEEP_RECENT_ITEM_COUNT = 8;

function createTimestamp(): string {
  return new Date().toISOString();
}

function estimateItemChars(item: AgentContextItemRecord): number {
  if (item.itemType === "message" && item.message) {
    return getPromptFacingContent(item).length + item.message.attachments.length * 64;
  }
  if (item.itemType === "summary" && item.summary) {
    return item.summary.content.length;
  }
  return 0;
}

function getPromptFacingContent(item: AgentContextItemRecord): string {
  if (item.itemType === "summary") {
    return item.summary?.content ?? "";
  }

  const message = item.message;
  if (!message) {
    return "";
  }

  if (message.source === "room_incoming") {
    return message.parts.find((part) => part.partType === "incoming_room_envelope")?.textContent || message.content;
  }

  if (message.source === "room_run_completion") {
    return message.parts.find((part) => part.partType === "assistant_history_entry")?.textContent || message.content;
  }

  if (message.source === "continuation_snapshot") {
    return message.parts.find((part) => part.partType === "continuation_snapshot")?.textContent || message.content;
  }

  return message.content;
}

function estimateContextChars(items: AgentContextItemRecord[]): number {
  return items.reduce((total, item) => total + estimateItemChars(item), 0);
}

function itemToCompactionMessage(item: AgentContextItemRecord): PersistedVisibleMessage | null {
  if (item.itemType === "message" && item.message) {
    return {
      id: item.message.messageId,
      role: item.message.role === "system" ? "assistant" : item.message.role,
      content: getPromptFacingContent(item),
      attachments: [...item.message.attachments],
      ...(item.message.meta ? { meta: item.message.meta } : {}),
      createdAt: item.message.createdAt,
    };
  }

  if (item.itemType === "summary" && item.summary) {
    return {
      id: item.summary.summaryId,
      role: "assistant",
      content: `[Prior compacted summary]\n${item.summary.content}`,
      attachments: [],
      createdAt: item.summary.createdAt,
    };
  }

  return null;
}

function determineSplitIndex(items: AgentContextItemRecord[], force: boolean): number {
  if (force) {
    return Math.max(1, Math.floor(items.length / 2));
  }

  let splitIndex = Math.max(1, items.length - KEEP_RECENT_ITEM_COUNT);
  const latestContinuationIndex = (() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.itemType === "message" && item.message?.source === "continuation_snapshot") {
        return index;
      }
    }
    return -1;
  })();

  if (latestContinuationIndex >= 0 && latestContinuationIndex < splitIndex) {
    splitIndex = latestContinuationIndex;
  }

  return Math.max(1, splitIndex);
}

export async function compactAgentContext(args: {
  agentId: RoomAgentId;
  reason: "automatic" | "manual";
  force?: boolean;
  resolvedModel: string;
}): Promise<AgentContextCompactionResult> {
  const state = await getAgentContextStateSnapshot(args.agentId);
  if (!state || state.items.length < 4) {
    return {
      compacted: false,
      prunedItems: 0,
      keptItems: state?.items.length ?? 0,
      charsBefore: state ? estimateContextChars(state.items) : 0,
      charsAfter: state ? estimateContextChars(state.items) : 0,
    };
  }

  const charsBefore = estimateContextChars(state.items);
  const shouldCompact = args.force || (state.items.length > KEEP_RECENT_ITEM_COUNT + 2 && charsBefore >= AUTO_COMPACT_CHAR_THRESHOLD);
  if (!shouldCompact) {
    return {
      compacted: false,
      prunedItems: 0,
      keptItems: state.items.length,
      charsBefore,
      charsAfter: charsBefore,
    };
  }

  const splitIndex = determineSplitIndex(state.items, args.force === true);
  const prunedItems = state.items.slice(0, splitIndex);
  const keptItems = state.items.slice(splitIndex);
  if (prunedItems.length === 0) {
    return {
      compacted: false,
      prunedItems: 0,
      keptItems: state.items.length,
      charsBefore,
      charsAfter: charsBefore,
    };
  }

  const compactionMessages = prunedItems
    .map((item) => itemToCompactionMessage(item))
    .filter((item): item is PersistedVisibleMessage => Boolean(item));
  const summary = await generateCompactionSummary({
    agentId: args.agentId,
    messages: compactionMessages,
    resolvedModel: args.resolvedModel,
  });
  const summaryId = createUuid();
  const summaryKind = prunedItems.some((item) => item.itemType === "summary") ? "condensed" : "leaf";
  const summaryDepth = prunedItems.reduce((depth, item) => {
    if (item.itemType === "summary" && item.summary) {
      return Math.max(depth, item.summary.depth + 1);
    }
    return depth;
  }, summaryKind === "leaf" ? 0 : 1);
  const createdAt = createTimestamp();

  await insertAgentContextSummary({
    agentId: args.agentId,
    summaryId,
    kind: summaryKind,
    depth: summaryDepth,
    content: summary,
    tokenCount: Math.max(1, Math.ceil(summary.length / 4)),
    messageIds: prunedItems
      .map((item) => item.message?.messageId)
      .filter((messageId): messageId is string => Boolean(messageId)),
    parentSummaryIds: prunedItems
      .map((item) => item.summary?.summaryId)
      .filter((parentSummaryId): parentSummaryId is string => Boolean(parentSummaryId)),
    metadata: {
      reason: args.reason,
      prunedOrdinals: prunedItems.map((item) => item.ordinal),
    },
    createdAt,
  });

  await replaceAgentContextRangeWithSummary({
    agentId: args.agentId,
    startOrdinal: prunedItems[0]?.ordinal ?? 0,
    endOrdinal: prunedItems[prunedItems.length - 1]?.ordinal ?? 0,
    summaryId,
    createdAt,
  });

  const nextState = await getAgentContextStateSnapshot(args.agentId);
  const charsAfter = nextState ? estimateContextChars(nextState.items) : Math.max(0, charsBefore - summary.length);

  await appendAgentCompactionMemory({
    agentId: args.agentId,
    summary,
    reason: args.reason,
    prunedMessages: prunedItems.length,
    charsBefore,
    charsAfter,
  });

  return {
    compacted: true,
    summaryId,
    summaryKind,
    summary,
    prunedItems: prunedItems.length,
    keptItems: keptItems.length,
    charsBefore,
    charsAfter,
  };
}
