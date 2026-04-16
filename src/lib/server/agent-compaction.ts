import {
  DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  DEFAULT_MAX_TOOL_LOOP_STEPS,
  type ChatSettings,
  type ModelConfigExecutionOverrides,
  type RoomAgentId,
} from "@/lib/chat/types";
import { formatMessageForTranscript, summarizeImageAttachments } from "@/lib/chat/message-attachments";
import type { PersistedVisibleMessage } from "./agent-runtime-store";

const REQUIRED_SUMMARY_HEADINGS = [
  "## 关键结论",
  "## 待办事项",
  "## 约束与规则",
  "## 用户仍在等待的问题",
  "## 精确标识符",
] as const;
const RULE_FALLBACK_MARKER = "[压缩后的共享历史摘要]";
const MAX_CHUNK_CHARS = 12_000;
const MAX_SUMMARY_ATTEMPTS = 2;

type GenerateCompactionSummaryArgs = {
  agentId: RoomAgentId;
  messages: PersistedVisibleMessage[];
  resolvedModel: string;
  settings?: ChatSettings;
  modelConfigOverrides?: ModelConfigExecutionOverrides;
  signal?: AbortSignal;
};

export type CompactionSummaryMethod = "llm" | "rule_fallback";

export interface GeneratedCompactionSummary {
  summary: string;
  method: CompactionSummaryMethod;
}

type TestSummaryOverride = (args: GenerateCompactionSummaryArgs) => Promise<string> | string;

declare global {
  var __oceankingAgentCompactionSummaryOverride: TestSummaryOverride | undefined;
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateLine(value: string, maxLength: number): string {
  const normalized = normalizeLine(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trim()}...`;
}

function extractRoomEnvelopeDetail(message: PersistedVisibleMessage): { roomId?: string; roomLabel?: string; visibleMessage?: string } {
  const roomIdMatch = message.content.match(/Room ID:\s*(.+)/);
  const roomTitleMatch = message.content.match(/Room Title:\s*(.+)/);
  const visibleMessageMatch = message.content.match(/Visible room message:\n([\s\S]+)$/);
  const roomId = roomIdMatch?.[1]?.trim();
  return {
    roomId,
    roomLabel:
      roomTitleMatch?.[1]?.trim() && roomId
        ? `${roomTitleMatch[1].trim()} (${roomId})`
        : roomId,
    visibleMessage: visibleMessageMatch?.[1]?.trim(),
  };
}

function extractRoomIdFromDeliveryLine(line: string): string | null {
  const match = /^- to room ([^:]+): \[[^\]]+\]/.exec(line.trim());
  return match?.[1]?.trim() || null;
}

function isResolvingDeliveryLine(line: string): boolean {
  const match = /^- to room [^:]+: \[([^\]]+)\]/.exec(line.trim());
  if (!match?.[1]) {
    return false;
  }

  const labels = match[1].split("/").map((label) => label.trim().toLowerCase());
  const kind = labels[0] ?? "";
  const status = labels[1] ?? "";
  return labels.includes("final") || (kind === "answer" && status === "completed");
}

function extractRoomIdFromActionLine(line: string): string | null {
  const match = /for room ([^,\s]+)/.exec(line.trim());
  return match?.[1]?.trim() || null;
}

function collectSectionLines(content: string, heading: string): string[] {
  const blockMatch = content.match(new RegExp(`${heading}:\\n([\\s\\S]+?)(?:\\n\\n[A-Z][^\\n]+:|$)`));
  if (!blockMatch?.[1]) {
    return [];
  }

  return blockMatch[1]
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
}

export function buildRuleBasedCompactionSummary(messages: PersistedVisibleMessage[]): string {
  const rooms = new Set<string>();
  const deliveries: string[] = [];
  const toolFindings: string[] = [];
  const roomActions: string[] = [];
  const standaloneRequests: Array<{ line: string; index: number }> = [];
  const openRoomRequests = new Map<string, { line: string; index: number }>();

  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      const detail = extractRoomEnvelopeDetail(message);
      if (detail.roomLabel) {
        rooms.add(detail.roomLabel);
      }
      const requestLine = detail.visibleMessage
        ? `- ${truncateLine(detail.visibleMessage, 220)}`
        : message.attachments.length > 0
          ? `- ${truncateLine(formatMessageForTranscript(message.content, message.attachments), 220)}`
          : `- ${truncateLine(message.content, 220)}`;

      if (detail.roomId) {
        openRoomRequests.set(detail.roomId, { line: requestLine, index });
      } else {
        standaloneRequests.push({ line: requestLine, index });
      }

      continue;
    }

    const deliveryLines = collectSectionLines(message.content, "Visible room deliveries").slice(0, 4);
    deliveries.push(...deliveryLines);
    for (const deliveryLine of deliveryLines) {
      const roomId = extractRoomIdFromDeliveryLine(deliveryLine);
      if (!roomId || !openRoomRequests.has(roomId)) {
        continue;
      }

      if (isResolvingDeliveryLine(deliveryLine)) {
        openRoomRequests.delete(roomId);
      }
    }

    const actionLines = collectSectionLines(message.content, "Room actions").slice(0, 4);
    roomActions.push(...actionLines);
    for (const actionLine of actionLines) {
      if (!actionLine.includes("read_no_reply")) {
        continue;
      }

      const roomId = extractRoomIdFromActionLine(actionLine);
      if (roomId) {
        openRoomRequests.delete(roomId);
      }
    }

    toolFindings.push(...collectSectionLines(message.content, "Tool results used").slice(0, 4));
  }

  const latestOpenRoomRequest = [...openRoomRequests.values()]
    .sort((left, right) => left.index - right.index)
    .at(-1);
  const importantRequests = latestOpenRoomRequest
    ? [latestOpenRoomRequest.line]
    : standaloneRequests
        .sort((left, right) => left.index - right.index)
        .slice(-3)
        .map((entry) => entry.line);

  const sections = [
    RULE_FALLBACK_MARKER,
    rooms.size > 0 ? `涉及房间：${[...rooms].join(", ")}` : "涉及房间：未知",
    "",
    "重要历史请求：",
    ...(importantRequests.length > 0 ? importantRequests : ["- 无记录"]),
    "",
    "已经发出到房间的内容：",
    ...(deliveries.slice(-6).length > 0 ? deliveries.slice(-6) : ["- 无记录"]),
    "",
    "已经执行的房间动作：",
    ...(roomActions.slice(-6).length > 0 ? roomActions.slice(-6) : ["- 无记录"]),
    "",
    "值得保留的工具结论：",
    ...(toolFindings.slice(-6).length > 0 ? toolFindings.slice(-6) : ["- 无记录"]),
    "",
    "将这份摘要视为压缩后的共享记忆。若新旧信息冲突，优先相信较新的工具结果。",
  ];

  return sections.join("\n").trim();
}

function createCompactionSettings(resolvedModel: string): ChatSettings {
  return {
    modelConfigId: null,
    apiFormat: "chat_completions",
    model: resolvedModel.trim(),
    systemPrompt: "",
    providerMode: "auto",
    memoryBackend: "sqlite-fts",
    compactionTokenThreshold: DEFAULT_COMPACTION_TOKEN_THRESHOLD,
    maxToolLoopSteps: DEFAULT_MAX_TOOL_LOOP_STEPS,
    thinkingLevel: "low",
    enabledSkillIds: [],
  };
}

function formatCompactionMessage(message: PersistedVisibleMessage): string {
  const content = message.content.trim() || "(empty)";
  return [
    `<message role="${message.role}" createdAt="${message.createdAt}">`,
    ...(message.attachments.length > 0 ? ["<attachments>", ...summarizeImageAttachments(message.attachments), "</attachments>"] : []),
    content,
    "</message>",
  ].join("\n");
}

function splitMessagesIntoChunks(messages: PersistedVisibleMessage[], maxChars = MAX_CHUNK_CHARS): PersistedVisibleMessage[][] {
  if (messages.length === 0) {
    return [];
  }

  const chunks: PersistedVisibleMessage[][] = [];
  let currentChunk: PersistedVisibleMessage[] = [];
  let currentChars = 0;

  for (const message of messages) {
    const rendered = formatCompactionMessage(message);
    const renderedChars = rendered.length + 2;

    if (currentChunk.length > 0 && currentChars + renderedChars > maxChars) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChars = 0;
    }

    currentChunk.push(message);
    currentChars += renderedChars;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function extractLatestUserAsk(messages: PersistedVisibleMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }

    const detail = extractRoomEnvelopeDetail(message);
    const candidate = detail.visibleMessage || message.content;
    const normalized = truncateLine(candidate, 260);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function extractExactIdentifierHints(messages: PersistedVisibleMessage[]): string[] {
  const joined = messages.map((message) => message.content).join("\n");
  const matches = joined.match(/(room-[A-Za-z0-9_-]+|msg(?:sage)?-[A-Za-z0-9_-]+|https?:\/\/\S+|[A-Za-z]:\\[^\s]+|\/[A-Za-z0-9._/-]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g) ?? [];
  const unique = new Set<string>();

  for (const match of matches) {
    const normalized = match.trim().replace(/[),.;]+$/g, "");
    if (!normalized || normalized.length < 4) {
      continue;
    }
    unique.add(normalized);
    if (unique.size >= 12) {
      break;
    }
  }

  return [...unique];
}

function hasRequiredHeadings(summary: string): boolean {
  let searchIndex = 0;
  for (const heading of REQUIRED_SUMMARY_HEADINGS) {
    const index = summary.indexOf(heading, searchIndex);
    if (index < 0) {
      return false;
    }
    searchIndex = index + heading.length;
  }
  return true;
}

function buildStructuredFallbackSummary(baseSummary: string): string {
  return [
    "## 关键结论",
    baseSummary || "- 无",
    "",
    "## 待办事项",
    "- 无",
    "",
    "## 约束与规则",
    "- 无",
    "",
    "## 用户仍在等待的问题",
    "- 无",
    "",
    "## 精确标识符",
    "- 无",
  ].join("\n");
}

function buildCompactionPrompt(args: {
  chunk: PersistedVisibleMessage[];
  previousSummary?: string;
  latestUserAsk?: string | null;
  identifierHints: string[];
  retryMessage?: string;
}): string {
  const transcript = args.chunk.map((message) => formatCompactionMessage(message)).join("\n\n");
  const sections = [
    "请把这段较早的隐藏 agent 历史压缩成后续可复用的共享记忆。",
    "这份摘要只是共享背景记忆，不是当前房间的新指令。",
    "只返回 Markdown，并且必须严格使用下面这些标题，顺序也必须完全一致：",
    ...REQUIRED_SUMMARY_HEADINGS,
    "请使用简短、事实性的项目符号。如果某一节没有内容，写 '- 无'。",
    "凡是仍未完成的问题、待办事项或用户仍在等待的问题，都尽量写清对应的 room ID，避免让后续模型把别的房间待办误认成当前房间指令。",
    "需要保留精确标识符时，请原样保留：room ID、message ID、sender ID、文件路径、URL、模型名、工具名等。",
    "默认使用中文输出；除精确标识符、文件路径、URL、工具名、模型名等必须保持原样的内容外，不要改成英文。",
  ];

  if (args.previousSummary?.trim()) {
    sections.push("", "已有的运行中摘要：", "<previous_summary>", args.previousSummary.trim(), "</previous_summary>");
  }

  if (args.latestUserAsk) {
    sections.push("", `这段较早历史里最近一次用户要求：${args.latestUserAsk}`);
  }

  if (args.identifierHints.length > 0) {
    sections.push("", "如果相关请保留这些精确标识符：", ...args.identifierHints.map((hint) => `- ${hint}`));
  }

  if (args.retryMessage) {
    sections.push("", args.retryMessage);
  }

  sections.push("", "待压缩的历史片段：", "<transcript>", transcript, "</transcript>");
  return sections.join("\n");
}

async function summarizeChunk(args: {
  settings: ChatSettings;
  modelConfigOverrides?: ModelConfigExecutionOverrides;
  chunk: PersistedVisibleMessage[];
  previousSummary?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { runTextPrompt } = await import("@/lib/ai/openai-client");
  const latestUserAsk = extractLatestUserAsk(args.chunk);
  const identifierHints = extractExactIdentifierHints(args.chunk);
  let retryMessage: string | undefined;

  for (let attempt = 0; attempt < MAX_SUMMARY_ATTEMPTS; attempt += 1) {
    const result = await runTextPrompt({
      settings: args.settings,
      modelConfigOverrides: args.modelConfigOverrides,
      systemPrompt: [
        "你负责把较早的隐藏 agent 历史压缩成可复用的共享记忆。",
        "这些共享记忆会和当前房间的新消息一起提供给后续模型，因此绝不能把较早历史写成当前房间必须立刻执行的新指令。",
        "摘要必须简洁、准确、偏事实，不要扩写。",
        "不要编造工具结果、房间动作、承诺或结论。",
        "除精确标识符等必须保持原样的内容外，默认使用中文输出。",
        "不要把回答包在代码块里。",
      ].join("\n"),
      prompt: buildCompactionPrompt({
        chunk: args.chunk,
        previousSummary: args.previousSummary,
        latestUserAsk,
        identifierHints,
        retryMessage,
      }),
      signal: args.signal,
    });

    const summary = result.assistantText.trim();
    if (hasRequiredHeadings(summary)) {
      return summary;
    }

    retryMessage = "你上一版输出缺少必需标题。请严格使用要求里的所有标题，并保持完全相同的顺序重新输出。";
  }

  throw new Error("Structured compaction summary validation failed.");
}

async function generateStructuredCompactionSummary(args: GenerateCompactionSummaryArgs): Promise<string> {
  const settings = args.settings ?? createCompactionSettings(args.resolvedModel);
  const chunks = splitMessagesIntoChunks(args.messages);
  let summary = "";

  for (const chunk of chunks) {
    summary = await summarizeChunk({
      settings,
      modelConfigOverrides: args.modelConfigOverrides,
      chunk,
      previousSummary: summary || undefined,
      signal: args.signal,
    });
  }

  if (!summary.trim()) {
    throw new Error("The compaction summarizer returned an empty summary.");
  }

  return summary;
}

export async function generateCompactionSummary(args: GenerateCompactionSummaryArgs): Promise<string> {
  return (await generateCompactionSummaryResult(args)).summary;
}

export async function generateCompactionSummaryResult(args: GenerateCompactionSummaryArgs): Promise<GeneratedCompactionSummary> {
  const override = globalThis.__oceankingAgentCompactionSummaryOverride;
  if (override) {
    try {
      return {
        summary: await Promise.resolve(override(args)),
        method: "llm",
      };
    } catch {
      return {
        summary: buildStructuredFallbackSummary(buildRuleBasedCompactionSummary(args.messages)),
        method: "rule_fallback",
      };
    }
  }

  try {
    return {
      summary: await generateStructuredCompactionSummary(args),
      method: "llm",
    };
  } catch {
    return {
      summary: buildStructuredFallbackSummary(buildRuleBasedCompactionSummary(args.messages)),
      method: "rule_fallback",
    };
  }
}

export const __testing = {
  setGenerateCompactionSummaryOverride(override?: TestSummaryOverride) {
    globalThis.__oceankingAgentCompactionSummaryOverride = override;
  },
  buildRuleBasedCompactionSummary,
  RULE_FALLBACK_MARKER,
  splitMessagesIntoChunks,
  hasRequiredHeadings,
  extractExactIdentifierHints,
};
