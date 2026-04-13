"use client";

import { useEffect, useMemo, useState } from "react";
import { getAgentParticipants } from "@/components/workspace-provider";
import type { RoomAgentId, RoomSession } from "@/lib/chat/types";

export interface CompactionLogEntry {
  id: string;
  createdAt: string;
  agentLabel: string;
  trigger: "post_turn" | "post_tool" | "manual";
  success: boolean;
  actionTaken: boolean;
  method: "llm" | "rule_fallback" | "unknown";
  summary: string;
  error: string;
  prunedMessages: number;
  keptMessages: number;
  details?: {
    thresholdTokens: number;
    contextTokens: number;
    storedContextTokens: number;
    promptOverheadTokens: number;
    totalEstimatedTokens: number;
    systemPromptTokens: number;
    toolSchemaTokens: number;
    attachmentTokens: number;
    result: string;
    contextTokensAfter?: number;
    storedContextTokensAfter?: number;
    tokensAfter?: number;
    totalEstimatedTokensAfter?: number;
  };
  summaryRef?: {
    summaryId: string;
    kind: "leaf" | "condensed";
    depth: number;
    tokenCount: number;
    sourceMessageTokenCount: number;
    descendantCount: number;
    descendantTokenCount: number;
    messageIds: number[];
    parentIds: string[];
    childIds: string[];
    subtree: Array<{
      summaryId: string;
      parentSummaryId: string | null;
      depthFromRoot: number;
      kind: "leaf" | "condensed";
      depth: number;
      tokenCount: number;
      childCount: number;
      sourceMessageTokenCount: number;
    }>;
    directChildren: Array<{
      summaryId: string;
      kind: "leaf" | "condensed";
      tokenCount: number;
      preview: string;
    }>;
    directMessages: Array<{
      messageId: number;
      role: string;
      tokenCount: number;
      preview: string;
    }>;
    mappingTruncated: boolean;
  };
}

function getSortableTime(value: string) {
  const timestamp = Date.parse(value || "");
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getNumberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getStringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function getNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number") : [];
}

function normalizeCompactionSummaryRef(value: unknown): CompactionLogEntry["summaryRef"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return {
    summaryId: getStringField(record.summaryId),
    kind: record.kind === "condensed" ? "condensed" : "leaf",
    depth: getNumberField(record.depth),
    tokenCount: getNumberField(record.tokenCount),
    sourceMessageTokenCount: getNumberField(record.sourceMessageTokenCount),
    descendantCount: getNumberField(record.descendantCount),
    descendantTokenCount: getNumberField(record.descendantTokenCount),
    messageIds: getNumberArray(record.messageIds),
    parentIds: getStringArray(record.parentIds),
    childIds: getStringArray(record.childIds),
    subtree: Array.isArray(record.subtree)
      ? (record.subtree as NonNullable<CompactionLogEntry["summaryRef"]>["subtree"])
      : [],
    directChildren: Array.isArray(record.directChildren)
      ? (record.directChildren as NonNullable<CompactionLogEntry["summaryRef"]>["directChildren"])
      : [],
    directMessages: Array.isArray(record.directMessages)
      ? (record.directMessages as NonNullable<CompactionLogEntry["summaryRef"]>["directMessages"])
      : [],
    mappingTruncated: Boolean(record.mappingTruncated),
  };
}

function normalizeCompactionDetails(value: unknown): CompactionLogEntry["details"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return {
    thresholdTokens: getNumberField(record.thresholdTokens),
    contextTokens: getNumberField(record.contextTokens),
    storedContextTokens: getNumberField(record.storedContextTokens),
    promptOverheadTokens: getNumberField(record.promptOverheadTokens),
    totalEstimatedTokens: getNumberField(record.totalEstimatedTokens),
    systemPromptTokens: getNumberField(record.systemPromptTokens),
    toolSchemaTokens: getNumberField(record.toolSchemaTokens),
    attachmentTokens: getNumberField(record.attachmentTokens),
    result: getStringField(record.result, "unknown"),
    ...(typeof record.tokensAfter === "number" ? { tokensAfter: record.tokensAfter } : {}),
    ...(typeof record.contextTokensAfter === "number" ? { contextTokensAfter: record.contextTokensAfter } : {}),
    ...(typeof record.storedContextTokensAfter === "number" ? { storedContextTokensAfter: record.storedContextTokensAfter } : {}),
    ...(typeof record.totalEstimatedTokensAfter === "number" ? { totalEstimatedTokensAfter: record.totalEstimatedTokensAfter } : {}),
  };
}

function normalizeCompactionLogRecord(args: {
  record: Record<string, unknown>;
  agentId: RoomAgentId;
  agentLabel: string;
  index: number;
}): CompactionLogEntry {
  const details = normalizeCompactionDetails(args.record.details);
  const summaryRef = normalizeCompactionSummaryRef(args.record.summaryRef);
  return {
    id: getStringField(args.record.id, `${args.agentId}-${args.index}`),
    createdAt: getStringField(args.record.createdAt),
    agentLabel: args.agentLabel,
    trigger: args.record.reason === "post_tool"
      ? "post_tool"
      : args.record.reason === "post_turn" || args.record.reason === "automatic"
        ? "post_turn"
        : "manual",
    success: typeof args.record.success === "boolean" ? args.record.success : true,
    actionTaken: typeof args.record.actionTaken === "boolean" ? args.record.actionTaken : true,
    method: args.record.method === "llm" || args.record.method === "rule_fallback" || args.record.method === "unknown"
      ? args.record.method
      : "unknown",
    summary: getStringField(args.record.summary),
    error: getStringField(args.record.error),
    prunedMessages: getNumberField(args.record.prunedMessages),
    keptMessages: getNumberField(args.record.keptMessages),
    ...(details ? { details } : {}),
    ...(summaryRef ? { summaryRef } : {}),
  };
}

async function fetchAgentCompactionLogs(args: {
  agentId: RoomAgentId;
  agentLabel: string;
}): Promise<CompactionLogEntry[]> {
  const response = await fetch(`/api/agent-runtime/compactions?agentId=${encodeURIComponent(args.agentId)}`, { cache: "no-store" }).catch(() => null);
  const payload = response ? (await response.json().catch(() => null)) as { compactions?: Array<Record<string, unknown>> } | null : null;
  if (!response?.ok || !payload?.compactions) {
    return [];
  }

  return payload.compactions.map((record, index) => normalizeCompactionLogRecord({
    record,
    agentId: args.agentId,
    agentLabel: args.agentLabel,
    index,
  }));
}

export function useRoomCompactionLogs(args: {
  room: RoomSession | undefined;
  getAgentDefinition: (agentId: RoomAgentId) => { label: string };
}): CompactionLogEntry[] {
  const { room, getAgentDefinition } = args;
  const [compactionLogs, setCompactionLogs] = useState<CompactionLogEntry[]>([]);
  const agentIds = useMemo(
    () => room
      ? [...new Set(getAgentParticipants(room)
          .map((participant) => participant.agentId)
          .filter((agentId): agentId is RoomAgentId => Boolean(agentId)))]
      : [],
    [room],
  );

  useEffect(() => {
    let cancelled = false;

    if (!room) {
      return;
    }

    if (agentIds.length === 0) {
      return;
    }

    const refreshCompactionLogs = () => {
      void (async () => {
        const entries = await Promise.all(
          agentIds.map((agentId) => fetchAgentCompactionLogs({
            agentId,
            agentLabel: getAgentDefinition(agentId).label,
          })),
        );

        if (!cancelled) {
          setCompactionLogs(entries.flat().sort((left, right) => getSortableTime(right.createdAt) - getSortableTime(left.createdAt)));
        }
      })();
    };

    refreshCompactionLogs();
    const intervalId = window.setInterval(refreshCompactionLogs, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [agentIds, getAgentDefinition, room]);

  return room && agentIds.length > 0 ? compactionLogs : [];
}
