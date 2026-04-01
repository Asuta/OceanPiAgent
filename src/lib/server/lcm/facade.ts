import { createHash } from "node:crypto";
import type { AssistantMessageMeta, MessageImageAttachment, ProviderCompatibility, RoomAgentId, RoomMessageEmission, RoomSender, RoomToolActionUnion, ToolExecution } from "@/lib/chat/types";
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

export async function getLcmStores() {
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
      contextThreshold: 0.75,
      freshTailCount: 8,
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
}): Promise<string> {
  if (args.text.trim().length < LARGE_TEXT_THRESHOLD) {
    return args.text;
  }

  const fileId = `file_${createHash("sha256").update(`${args.agentId}:${args.toolName ?? "text"}:${args.text}`).digest("hex").slice(0, 16)}`;
  const existing = await args.summaryStore.getLargeFile(fileId);
  if (!existing) {
    const summary = await generateExplorationSummary({
      content: args.text,
      fileName: args.toolName ? `${args.toolName}.txt` : undefined,
      mimeType: "text/plain",
    });
    await args.summaryStore.insertLargeFile({
      fileId,
      conversationId: args.conversationId,
      fileName: args.toolName ? `${args.toolName}.txt` : undefined,
      mimeType: "text/plain",
      byteSize: Buffer.byteLength(args.text, "utf8"),
      storageUri: `memory://agent/${args.agentId}/${fileId}`,
      explorationSummary: summary,
    });
  }

  return formatToolOutputReference({
    fileId,
    toolName: args.toolName ?? undefined,
    byteSize: Buffer.byteLength(args.text, "utf8"),
    summary: (await args.summaryStore.getLargeFile(fileId))?.explorationSummary ?? "",
  });
}

export async function appendAgentLcmMessage(args: {
  agentId: RoomAgentId;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt?: string;
  parts?: CreateMessagePartInput[];
  title?: string;
}): Promise<number> {
  const { conversationStore, summaryStore } = await getLcmStores();
  const conversation = await conversationStore.getOrCreateConversation(getAgentSessionId(args.agentId), {
    sessionKey: args.agentId,
    title: args.title ?? `Agent ${args.agentId}`,
  });
  const seq = (await conversationStore.getMaxSeq(conversation.conversationId)) + 1;

  const normalizedContent = await maybeExternalizeLargeText({
    agentId: args.agentId,
    conversationId: conversation.conversationId,
    summaryStore,
    text: args.content,
  });
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
            })
          : part.toolOutput;
        const externalizedPreview = typeof part.textContent === "string"
          ? await maybeExternalizeLargeText({
              agentId: args.agentId,
              conversationId: conversation.conversationId,
              summaryStore,
              text: part.textContent,
              toolName: part.toolName,
            })
          : part.textContent;
        return {
          ...part,
          textContent: externalizedPreview,
          toolOutput: externalizedOutput,
        };
      }))
    : undefined;

  const message = await conversationStore.createMessage({
    conversationId: conversation.conversationId,
    seq,
    role: args.role,
    content: normalizedContent,
    createdAt: args.createdAt,
  });
  if (normalizedParts?.length) {
    await conversationStore.createMessageParts(message.messageId, normalizedParts);
  }
  await summaryStore.appendContextMessage(conversation.conversationId, message.messageId, args.createdAt);
  await conversationStore.markConversationBootstrapped(conversation.conversationId);
  await summaryStore.upsertConversationBootstrapState({
    conversationId: conversation.conversationId,
    sessionFilePath: `live://agent/${args.agentId}`,
    lastSeenSize: Buffer.byteLength(normalizedContent, "utf8"),
    lastSeenMtimeMs: Date.now(),
    lastProcessedOffset: seq,
    lastProcessedEntryHash: createHash("sha256").update(`${seq}:${normalizedContent}`).digest("hex"),
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

export async function compactAgentLcmContext(agentId: RoomAgentId, tokenBudget: number, force?: boolean, summaryModel?: string) {
  const { conversationStore, compaction } = await getLcmStores();
  const conversation = await conversationStore.getConversationBySessionKey(agentId);
  if (!conversation) {
    return null;
  }
  return compaction.compact({ conversationId: conversation.conversationId, tokenBudget, force, summaryModel });
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
}) {
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
  return appendAgentLcmMessage({ agentId: args.agentId, role: "assistant", content: args.assistantText.trim() || args.assistantHistoryEntry, createdAt: args.createdAt, title: args.roomTitle, parts });
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
