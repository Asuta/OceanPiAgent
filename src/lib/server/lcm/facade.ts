import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_COMPACTION_FRESH_TAIL_COUNT, DEFAULT_COMPACTION_TOKEN_THRESHOLD } from "@/lib/chat/types";
import type { AssistantMessageMeta, MessageImageAttachment, ProviderCompatibility, RoomAgentId, RoomMessageEmission, RoomSender, RoomToolActionUnion, ToolExecution } from "@/lib/chat/types";
import type { CompactionModelSelection } from "@/lib/server/agent-compaction-settings";
import { getLcmDatabase } from "./db";
import { getLcmDbFeatures } from "./features";
import { formatToolOutputReference, generateExplorationSummary } from "./large-files";
import { ContextAssembler } from "./assembler";
import { CompactionEngine } from "./compaction";
import { ConversationStore, type CreateMessagePartInput } from "./conversation-store";
import { RetrievalEngine } from "./retrieval";
import { SummaryStore } from "./summary-store";

export function getAgentSessionId(agentId: RoomAgentId): string {
  return `agent:${agentId}`;
}

const LARGE_TEXT_THRESHOLD = 12_000;

export async function getLcmStores(
  compactionTokenThreshold = DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  compactionFreshTailCount = DEFAULT_COMPACTION_FRESH_TAIL_COUNT,
) {
  const db = await getLcmDatabase();
  const features = getLcmDbFeatures(db);
  const conversationStore = new ConversationStore(db, features);
  const summaryStore = new SummaryStore(db, features);
  return {
    db,
    features,
    conversationStore,
    summaryStore,
    assembler: new ContextAssembler(conversationStore, summaryStore),
    compaction: new CompactionEngine(conversationStore, summaryStore, {
      fixedTokenThreshold: compactionTokenThreshold,
      freshTailCount: compactionFreshTailCount,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20_000,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxRounds: 10,
    }),
    retrieval: new RetrievalEngine(conversationStore, summaryStore),
  };
}

export async function getOrCreateAgentConversation(agentId: RoomAgentId, title?: string) {
  const { conversationStore } = await getLcmStores();
  return conversationStore.getOrCreateConversation(getAgentSessionId(agentId), {
    sessionKey: agentId,
    title: title ?? `Agent ${agentId}`,
  });
}

function json(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

async function maybeExternalizeLargeText(args: {
  agentId: RoomAgentId;
  conversationId: number;
  summaryStore: SummaryStore;
  text: string;
  toolName?: string | null;
  source?: string;
  onTimingPhase?: (phase: string, details?: Record<string, unknown>) => void;
}): Promise<string> {
  if (args.text.trim().length < LARGE_TEXT_THRESHOLD) {
    return args.text;
  }

  args.onTimingPhase?.("lcm_large_text_externalize_needed", {
    source: args.source ?? "unknown",
    textChars: args.text.length,
    thresholdChars: LARGE_TEXT_THRESHOLD,
  });
  const fileId = `file_${createHash("sha256").update(`${args.agentId}:${args.toolName ?? "text"}:${args.text}`).digest("hex").slice(0, 16)}`;
  const existingLookupStartedAt = performance.now();
  const existing = await args.summaryStore.getLargeFile(fileId);
  args.onTimingPhase?.("lcm_large_text_lookup", {
    source: args.source ?? "unknown",
    durationMs: Math.max(0, performance.now() - existingLookupStartedAt),
    cacheHit: Boolean(existing),
  });
  if (!existing) {
    const summaryStartedAt = performance.now();
    const summary = await generateExplorationSummary({
      content: args.text,
      fileName: args.toolName ? `${args.toolName}.txt` : undefined,
      mimeType: "text/plain",
    });
    args.onTimingPhase?.("lcm_large_text_generate_summary", {
      source: args.source ?? "unknown",
      durationMs: Math.max(0, performance.now() - summaryStartedAt),
      textChars: args.text.length,
    });
    const insertStartedAt = performance.now();
    await args.summaryStore.insertLargeFile({
      fileId,
      conversationId: args.conversationId,
      fileName: args.toolName ? `${args.toolName}.txt` : undefined,
      mimeType: "text/plain",
      byteSize: Buffer.byteLength(args.text, "utf8"),
      storageUri: `memory://agent/${args.agentId}/${fileId}`,
      explorationSummary: summary,
    });
    args.onTimingPhase?.("lcm_large_text_inserted", {
      source: args.source ?? "unknown",
      durationMs: Math.max(0, performance.now() - insertStartedAt),
      byteSize: Buffer.byteLength(args.text, "utf8"),
    });
  }

  const readBackStartedAt = performance.now();
  const persisted = await args.summaryStore.getLargeFile(fileId);
  args.onTimingPhase?.("lcm_large_text_reference_readback", {
    source: args.source ?? "unknown",
    durationMs: Math.max(0, performance.now() - readBackStartedAt),
  });
  return formatToolOutputReference({
    fileId,
    toolName: args.toolName ?? undefined,
    byteSize: Buffer.byteLength(args.text, "utf8"),
    summary: persisted?.explorationSummary ?? "",
  });
}

export async function appendAgentLcmMessage(args: {
  agentId: RoomAgentId;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt?: string;
  parts?: CreateMessagePartInput[];
  title?: string;
  onTimingPhase?: (phase: string, details?: Record<string, unknown>) => void;
}): Promise<number> {
  const loadConversationStartedAt = performance.now();
  const { conversationStore, summaryStore } = await getLcmStores();
  const conversation = await conversationStore.getOrCreateConversation(getAgentSessionId(args.agentId), {
    sessionKey: args.agentId,
    title: args.title ?? `Agent ${args.agentId}`,
  });
  args.onTimingPhase?.("lcm_get_or_create_conversation", {
    durationMs: Math.max(0, performance.now() - loadConversationStartedAt),
    conversationId: conversation.conversationId,
  });
  const seqStartedAt = performance.now();
  const seq = (await conversationStore.getMaxSeq(conversation.conversationId)) + 1;
  args.onTimingPhase?.("lcm_get_next_seq", {
    durationMs: Math.max(0, performance.now() - seqStartedAt),
    seq,
  });

  const normalizeContentStartedAt = performance.now();
  const normalizedContent = await maybeExternalizeLargeText({
    agentId: args.agentId,
    conversationId: conversation.conversationId,
    summaryStore,
    text: args.content,
    source: "message_content",
    onTimingPhase: args.onTimingPhase,
  });
  args.onTimingPhase?.("lcm_normalize_content", {
    durationMs: Math.max(0, performance.now() - normalizeContentStartedAt),
    contentCharsBefore: args.content.length,
    contentCharsAfter: normalizedContent.length,
  });
  const normalizePartsStartedAt = performance.now();
  const normalizedParts = args.parts?.length
    ? await Promise.all(args.parts.map(async (part) => {
        if (part.partType !== "tool") {
          return part;
        }
        const externalizedOutput = typeof part.toolOutput === "string"
          ? await maybeExternalizeLargeText({
              agentId: args.agentId,
              conversationId: conversation.conversationId,
              summaryStore,
              text: part.toolOutput,
              toolName: part.toolName,
              source: `tool_output:${part.toolName ?? "unknown"}`,
              onTimingPhase: args.onTimingPhase,
            })
          : part.toolOutput;
        const externalizedPreview = typeof part.textContent === "string"
          ? await maybeExternalizeLargeText({
              agentId: args.agentId,
              conversationId: conversation.conversationId,
              summaryStore,
              text: part.textContent,
              toolName: part.toolName,
              source: `tool_preview:${part.toolName ?? "unknown"}`,
              onTimingPhase: args.onTimingPhase,
            })
          : part.textContent;
        return {
          ...part,
          textContent: externalizedPreview,
          toolOutput: externalizedOutput,
        };
      }))
    : undefined;
  args.onTimingPhase?.("lcm_normalize_parts", {
    durationMs: Math.max(0, performance.now() - normalizePartsStartedAt),
    partCount: args.parts?.length ?? 0,
    normalizedPartCount: normalizedParts?.length ?? 0,
  });

  const createMessageStartedAt = performance.now();
  const message = await conversationStore.createMessage({
    conversationId: conversation.conversationId,
    seq,
    role: args.role,
    content: normalizedContent,
    createdAt: args.createdAt,
  });
  args.onTimingPhase?.("lcm_create_message", {
    durationMs: Math.max(0, performance.now() - createMessageStartedAt),
    messageId: message.messageId,
  });
  if (normalizedParts?.length) {
    const createPartsStartedAt = performance.now();
    await conversationStore.createMessageParts(message.messageId, normalizedParts);
    args.onTimingPhase?.("lcm_create_message_parts", {
      durationMs: Math.max(0, performance.now() - createPartsStartedAt),
      partCount: normalizedParts.length,
    });
  }
  const appendContextStartedAt = performance.now();
  await summaryStore.appendContextMessage(conversation.conversationId, message.messageId, args.createdAt);
  args.onTimingPhase?.("lcm_append_context_message", {
    durationMs: Math.max(0, performance.now() - appendContextStartedAt),
  });
  const markBootstrappedStartedAt = performance.now();
  await conversationStore.markConversationBootstrapped(conversation.conversationId);
  args.onTimingPhase?.("lcm_mark_conversation_bootstrapped", {
    durationMs: Math.max(0, performance.now() - markBootstrappedStartedAt),
  });
  const bootstrapStateStartedAt = performance.now();
  await summaryStore.upsertConversationBootstrapState({
    conversationId: conversation.conversationId,
    sessionFilePath: `live://agent/${args.agentId}`,
    lastSeenSize: Buffer.byteLength(normalizedContent, "utf8"),
    lastSeenMtimeMs: Date.now(),
    lastProcessedOffset: seq,
    lastProcessedEntryHash: createHash("sha256").update(`${seq}:${normalizedContent}`).digest("hex"),
  });
  args.onTimingPhase?.("lcm_upsert_bootstrap_state", {
    durationMs: Math.max(0, performance.now() - bootstrapStateStartedAt),
  });
  return message.messageId;
}

export async function assembleAgentLcmContext(agentId: RoomAgentId, tokenBudget = 20_000) {
  const { conversationStore, assembler } = await getLcmStores();
  const conversation = await conversationStore.getConversationBySessionKey(agentId);
  if (!conversation) {
    return null;
  }
  return assembler.assemble({ conversationId: conversation.conversationId, tokenBudget });
}

export async function compactAgentLcmContext(
  agentId: RoomAgentId,
  tokenThreshold: number,
  force?: boolean,
  summaryModelSelection?: CompactionModelSelection,
  comparisonExtraTokens?: number,
  freshTailCount?: number,
) {
  const { conversationStore, compaction } = await getLcmStores(tokenThreshold, freshTailCount);
  const conversation = await conversationStore.getConversationBySessionKey(agentId);
  if (!conversation) {
    return null;
  }
  return compaction.compact({
    conversationId: conversation.conversationId,
    tokenBudget: tokenThreshold,
    force,
    summaryModelSelection,
    ...(typeof comparisonExtraTokens === "number" ? { comparisonExtraTokens } : {}),
  });
}

export async function compactScratchAgentLcmMessages(args: {
  agentId: RoomAgentId;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    createdAt?: string;
  }>;
  summaryModelSelection?: CompactionModelSelection;
  signal?: AbortSignal;
}): Promise<{
  summaryId: string;
  summaryText: string;
  tokensAfter: number;
} | null> {
  if (args.signal?.aborted) {
    return null;
  }

  const normalizedMessages = args.messages
    .map((message) => ({
      ...message,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0);
  if (normalizedMessages.length === 0) {
    return null;
  }

  const { conversationStore, summaryStore, compaction, retrieval } = await getLcmStores(1, 0);
  const conversation = await conversationStore.getOrCreateConversation(
    `${getAgentSessionId(args.agentId)}:post_tool:${randomUUID()}`,
    { title: `Agent ${args.agentId} post tool scratch compaction` },
  );

  const createdMessages = await conversationStore.createMessagesBulk(
    normalizedMessages.map((message, index) => ({
      conversationId: conversation.conversationId,
      seq: index + 1,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    })),
  );
  for (const message of createdMessages) {
    await summaryStore.appendContextMessage(conversation.conversationId, message.messageId, message.createdAt.toISOString());
  }
  await conversationStore.markConversationBootstrapped(conversation.conversationId);

  const result = await compaction.compact({
    conversationId: conversation.conversationId,
    tokenBudget: 1,
    force: true,
    hardTrigger: true,
    summaryModelSelection: args.summaryModelSelection,
    signal: args.signal,
  });
  if (args.signal?.aborted) {
    return null;
  }
  if (!result.actionTaken || !result.createdSummaryId) {
    return null;
  }

  const described = await retrieval.describe(result.createdSummaryId);
  const summaryText = described?.summary?.content?.trim();
  if (!summaryText) {
    return null;
  }

  return {
    summaryId: result.createdSummaryId,
    summaryText,
    tokensAfter: result.tokensAfter,
  };
}

export async function getAgentLcmStoredContextTokenCount(agentId: RoomAgentId): Promise<number | null> {
  const { conversationStore, summaryStore } = await getLcmStores();
  const conversation = await conversationStore.getConversationBySessionKey(agentId);
  if (!conversation) {
    return null;
  }
  return summaryStore.getContextTokenCount(conversation.conversationId);
}

export async function ingestIncomingRoomEnvelope(args: {
  agentId: RoomAgentId;
  requestId: string;
  roomId: string;
  roomTitle: string;
  userMessageId: string;
  userSender: RoomSender;
  userContent: string;
  userAttachments: MessageImageAttachment[];
  attachedRooms: Array<{ id: string; title: string; archived?: boolean }>;
  envelope: string;
  createdAt: string;
}) {
  return appendAgentLcmMessage({
    agentId: args.agentId,
    role: "user",
    content: args.envelope,
    createdAt: args.createdAt,
    title: args.roomTitle,
    parts: [
      {
        sessionId: getAgentSessionId(args.agentId),
        partType: "text",
        ordinal: 0,
        textContent: args.envelope,
        metadata: json({ originalRole: "user", rawType: "room_incoming", requestId: args.requestId, roomId: args.roomId, roomTitle: args.roomTitle, userMessageId: args.userMessageId, sender: args.userSender, attachments: args.userAttachments, attachedRooms: args.attachedRooms, raw: { envelope: args.envelope } }),
      },
    ],
  });
}

export async function ingestContinuationSnapshot(args: {
  agentId: RoomAgentId;
  requestId: string;
  snapshotText: string;
  roomId: string;
  roomTitle: string;
  userMessageId: string;
  userSender: RoomSender;
  userAttachments: MessageImageAttachment[];
  assistantContent: string;
  tools: ToolExecution[];
  emittedMessages: RoomMessageEmission[];
  roomActions: RoomToolActionUnion[];
  createdAt: string;
}) {
  const parts: CreateMessagePartInput[] = [
    {
      sessionId: getAgentSessionId(args.agentId),
      partType: "snapshot",
      ordinal: 0,
      textContent: args.snapshotText,
      metadata: json({ originalRole: "assistant", rawType: "continuation_snapshot", requestId: args.requestId, roomId: args.roomId, roomTitle: args.roomTitle, userMessageId: args.userMessageId }),
    },
  ];
  let ordinal = 1;
  if (args.assistantContent.trim()) {
    parts.push({ sessionId: getAgentSessionId(args.agentId), partType: "text", ordinal: ordinal++, textContent: args.assistantContent, metadata: json({ originalRole: "assistant", rawType: "partial_draft" }) });
  }
  for (const tool of args.tools) {
    parts.push({
      sessionId: getAgentSessionId(args.agentId),
      partType: "tool",
      ordinal: ordinal++,
      textContent: tool.resultPreview || tool.outputText,
      toolCallId: tool.id,
      toolName: tool.toolName,
      toolInput: tool.inputText,
      toolOutput: tool.outputText,
      metadata: json({ originalRole: tool.roomAction || tool.roomMessage ? "assistant" : "toolResult", rawType: "tool_event", raw: tool }),
    });
  }
  return appendAgentLcmMessage({ agentId: args.agentId, role: "assistant", content: args.snapshotText, createdAt: args.createdAt, title: args.roomTitle, parts });
}

export async function ingestCompletedRun(args: {
  agentId: RoomAgentId;
  requestId: string;
  assistantText: string;
  assistantHistoryEntry: string;
  roomId: string;
  roomTitle: string;
  userMessageId: string;
  userSender: RoomSender;
  userAttachments: MessageImageAttachment[];
  emittedMessages: RoomMessageEmission[];
  roomActions: RoomToolActionUnion[];
  tools: ToolExecution[];
  resolvedModel: string;
  compatibility: ProviderCompatibility;
  meta?: AssistantMessageMeta;
  createdAt: string;
  onTimingPhase?: (phase: string, details?: Record<string, unknown>) => void;
}) {
  const partsBuildStartedAt = performance.now();
  const parts: CreateMessagePartInput[] = [
    {
      sessionId: getAgentSessionId(args.agentId),
      partType: "text",
      ordinal: 0,
      textContent: args.assistantHistoryEntry,
      metadata: json({ originalRole: "assistant", rawType: "room_run_completion", requestId: args.requestId, roomId: args.roomId, roomTitle: args.roomTitle, userMessageId: args.userMessageId, resolvedModel: args.resolvedModel, compatibility: args.compatibility, meta: args.meta }),
    },
  ];
  let ordinal = 1;
  for (const tool of args.tools) {
    parts.push({
      sessionId: getAgentSessionId(args.agentId),
      partType: "tool",
      ordinal: ordinal++,
      textContent: tool.resultPreview || tool.outputText,
      toolCallId: tool.id,
      toolName: tool.toolName,
      toolInput: tool.inputText,
      toolOutput: tool.outputText,
      metadata: json({ originalRole: tool.roomAction || tool.roomMessage ? "assistant" : "toolResult", rawType: "tool_event", raw: tool }),
    });
  }
  args.onTimingPhase?.("ingest_completed_run_build_parts", {
    durationMs: Math.max(0, performance.now() - partsBuildStartedAt),
    toolCount: args.tools.length,
    assistantChars: args.assistantText.length,
    assistantHistoryEntryChars: args.assistantHistoryEntry.length,
  });
  return appendAgentLcmMessage({
    agentId: args.agentId,
    role: "assistant",
    content: args.assistantText.trim() || args.assistantHistoryEntry,
    createdAt: args.createdAt,
    title: args.roomTitle,
    parts,
    onTimingPhase: args.onTimingPhase,
  });
}

export async function getAgentLcmRetrieval(agentId: RoomAgentId) {
  const { conversationStore, retrieval } = await getLcmStores();
  const conversation = await conversationStore.getConversationBySessionKey(agentId);
  return { conversation, retrieval };
}

export async function clearAgentLcmConversation(agentId: RoomAgentId): Promise<void> {
  const { conversationStore } = await getLcmStores();
  await conversationStore.deleteConversationBySessionKey(agentId);
}

export function stableSummaryId(seed: string): string {
  return `sum_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

export function createLcmCompactionEventText(reason: string, before: number, after: number): string {
  return `LCM compaction ${reason}: ${before} -> ${after}`;
}

export function createLcmSyntheticPartText(content: string): string {
  return content.trim() || "(empty)";
}
