import { getAgentContextStateSnapshot, type AgentContextItemRecord } from "./agent-context-store";
import { loadPersistedAgentRuntime, type PersistedVisibleMessage } from "./agent-runtime-store";
import type { RoomAgentId } from "@/lib/chat/types";

const DEFAULT_CONTEXT_CHAR_BUDGET = 24_000;
const DEFAULT_KEEP_RECENT_ITEM_COUNT = 8;

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
    const envelope = message.parts.find((part) => part.partType === "incoming_room_envelope")?.textContent;
    return envelope || message.content;
  }

  if (message.source === "room_run_completion") {
    const historyEntry = message.parts.find((part) => part.partType === "assistant_history_entry")?.textContent;
    return historyEntry || message.content;
  }

  if (message.source === "continuation_snapshot") {
    const snapshot = message.parts.find((part) => part.partType === "continuation_snapshot")?.textContent;
    return snapshot || message.content;
  }

  return message.content;
}

function toPersistedVisibleMessage(item: AgentContextItemRecord): PersistedVisibleMessage | null {
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
      content: item.summary.content,
      attachments: [],
      createdAt: item.summary.createdAt,
    };
  }

  return null;
}

export async function assembleAgentContextHistory(args: {
  agentId: RoomAgentId;
  maxChars?: number;
  keepRecentItemCount?: number;
}): Promise<PersistedVisibleMessage[]> {
  const state = await getAgentContextStateSnapshot(args.agentId);
  if (!state || state.items.length === 0) {
    return (await loadPersistedAgentRuntime(args.agentId)).history;
  }

  const maxChars = typeof args.maxChars === "number" ? Math.max(1_000, Math.round(args.maxChars)) : DEFAULT_CONTEXT_CHAR_BUDGET;
  const keepRecentItemCount = typeof args.keepRecentItemCount === "number"
    ? Math.max(1, Math.round(args.keepRecentItemCount))
    : DEFAULT_KEEP_RECENT_ITEM_COUNT;

  const selectedOrdinals = new Set<number>();
  const selectedItems: AgentContextItemRecord[] = [];
  let estimatedChars = 0;

  const latestContinuationIndex = (() => {
    for (let index = state.items.length - 1; index >= 0; index -= 1) {
      const item = state.items[index];
      if (item.itemType === "message" && item.message?.source === "continuation_snapshot") {
        return index;
      }
    }
    return -1;
  })();

  for (let index = Math.max(0, state.items.length - keepRecentItemCount); index < state.items.length; index += 1) {
    const item = state.items[index];
    selectedOrdinals.add(item.ordinal);
    selectedItems.push(item);
    estimatedChars += estimateItemChars(item);
  }

  if (latestContinuationIndex >= 0) {
    const latestContinuation = state.items[latestContinuationIndex];
    if (!selectedOrdinals.has(latestContinuation.ordinal)) {
      selectedOrdinals.add(latestContinuation.ordinal);
      selectedItems.push(latestContinuation);
      estimatedChars += estimateItemChars(latestContinuation);
    }
  }

  for (let index = state.items.length - keepRecentItemCount - 1; index >= 0; index -= 1) {
    const item = state.items[index];
    if (selectedOrdinals.has(item.ordinal)) {
      continue;
    }

    const itemChars = estimateItemChars(item);
    if (selectedItems.length > 0 && estimatedChars + itemChars > maxChars) {
      continue;
    }

    selectedOrdinals.add(item.ordinal);
    selectedItems.push(item);
    estimatedChars += itemChars;
  }

  return selectedItems
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((item) => toPersistedVisibleMessage(item))
    .filter((item): item is PersistedVisibleMessage => Boolean(item));
}
