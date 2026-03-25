import { DEFAULT_MAX_TOOL_LOOP_STEPS, type ChatSettings, type RoomAgentId } from "@/lib/chat/types";
import type { PersistedVisibleMessage } from "./agent-runtime-store";

const REQUIRED_SUMMARY_HEADINGS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;
const MAX_CHUNK_CHARS = 12_000;
const MAX_SUMMARY_ATTEMPTS = 2;

type GenerateCompactionSummaryArgs = {
  agentId: RoomAgentId;
  messages: PersistedVisibleMessage[];
  resolvedModel: string;
  signal?: AbortSignal;
};

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

function extractRoomEnvelopeDetail(message: PersistedVisibleMessage): { roomLabel?: string; visibleMessage?: string } {
  const roomIdMatch = message.content.match(/Room ID:\s*(.+)/);
  const roomTitleMatch = message.content.match(/Room Title:\s*(.+)/);
  const visibleMessageMatch = message.content.match(/Visible room message:\n([\s\S]+)$/);
  return {
    roomLabel:
      roomTitleMatch?.[1]?.trim() && roomIdMatch?.[1]?.trim()
        ? `${roomTitleMatch[1].trim()} (${roomIdMatch[1].trim()})`
        : roomIdMatch?.[1]?.trim(),
    visibleMessage: visibleMessageMatch?.[1]?.trim(),
  };
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
  const userRequests: string[] = [];
  const deliveries: string[] = [];
  const toolFindings: string[] = [];
  const roomActions: string[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      const detail = extractRoomEnvelopeDetail(message);
      if (detail.roomLabel) {
        rooms.add(detail.roomLabel);
      }
      if (detail.visibleMessage) {
        userRequests.push(`- ${truncateLine(detail.visibleMessage, 220)}`);
      } else {
        userRequests.push(`- ${truncateLine(message.content, 220)}`);
      }
      continue;
    }

    deliveries.push(...collectSectionLines(message.content, "Visible room deliveries").slice(0, 4));
    roomActions.push(...collectSectionLines(message.content, "Room actions").slice(0, 4));
    toolFindings.push(...collectSectionLines(message.content, "Tool results used").slice(0, 4));
  }

  const sections = [
    "[Compacted shared history summary]",
    rooms.size > 0 ? `Rooms involved: ${[...rooms].join(", ")}` : "Rooms involved: unknown",
    "",
    "Important prior requests:",
    ...(userRequests.slice(-6).length > 0 ? userRequests.slice(-6) : ["- none recorded"]),
    "",
    "Visible deliveries already made:",
    ...(deliveries.slice(-6).length > 0 ? deliveries.slice(-6) : ["- none recorded"]),
    "",
    "Room actions already taken:",
    ...(roomActions.slice(-6).length > 0 ? roomActions.slice(-6) : ["- none recorded"]),
    "",
    "Tool findings worth keeping:",
    ...(toolFindings.slice(-6).length > 0 ? toolFindings.slice(-6) : ["- none recorded"]),
    "",
    "Treat this summary as compressed shared memory. Prefer newer tool results over older assumptions.",
  ];

  return sections.join("\n").trim();
}

function createCompactionSettings(resolvedModel: string): ChatSettings {
  return {
    apiFormat: "chat_completions",
    model: resolvedModel.trim(),
    systemPrompt: "",
    providerMode: "auto",
    maxToolLoopSteps: DEFAULT_MAX_TOOL_LOOP_STEPS,
    thinkingLevel: "low",
    enabledSkillIds: [],
  };
}

function formatCompactionMessage(message: PersistedVisibleMessage): string {
  const content = message.content.trim() || "(empty)";
  return [`<message role="${message.role}" createdAt="${message.createdAt}">`, content, "</message>"].join("\n");
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
    "## Decisions",
    baseSummary || "- none",
    "",
    "## Open TODOs",
    "- none",
    "",
    "## Constraints/Rules",
    "- none",
    "",
    "## Pending user asks",
    "- none",
    "",
    "## Exact identifiers",
    "- none",
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
    "Summarize this older hidden agent history for future continuity.",
    "Return markdown only using these exact headings in this exact order:",
    ...REQUIRED_SUMMARY_HEADINGS,
    "Use short factual bullets. If a section is empty, write '- none'.",
    "Preserve exact identifiers when they matter: room IDs, message IDs, sender IDs, file paths, URLs, model names, and tool names.",
  ];

  if (args.previousSummary?.trim()) {
    sections.push("", "Existing running summary:", "<previous_summary>", args.previousSummary.trim(), "</previous_summary>");
  }

  if (args.latestUserAsk) {
    sections.push("", `Most recent user ask in this older history: ${args.latestUserAsk}`);
  }

  if (args.identifierHints.length > 0) {
    sections.push("", "Identifier hints to preserve if relevant:", ...args.identifierHints.map((hint) => `- ${hint}`));
  }

  if (args.retryMessage) {
    sections.push("", args.retryMessage);
  }

  sections.push("", "Transcript chunk:", "<transcript>", transcript, "</transcript>");
  return sections.join("\n");
}

async function summarizeChunk(args: {
  settings: ChatSettings;
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
      systemPrompt: [
        "You compress prior hidden agent history into reusable shared memory.",
        "Keep the summary factual and compact.",
        "Do not invent tool results, room actions, or commitments.",
        "Do not wrap the answer in code fences.",
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

    retryMessage = "Your previous response did not include every required heading. Rewrite it with all headings exactly as requested.";
  }

  throw new Error("Structured compaction summary validation failed.");
}

async function generateStructuredCompactionSummary(args: GenerateCompactionSummaryArgs): Promise<string> {
  const settings = createCompactionSettings(args.resolvedModel);
  const chunks = splitMessagesIntoChunks(args.messages);
  let summary = "";

  for (const chunk of chunks) {
    summary = await summarizeChunk({
      settings,
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
  const override = globalThis.__oceankingAgentCompactionSummaryOverride;
  if (override) {
    try {
      return await Promise.resolve(override(args));
    } catch {
      return buildStructuredFallbackSummary(buildRuleBasedCompactionSummary(args.messages));
    }
  }

  try {
    return await generateStructuredCompactionSummary(args);
  } catch {
    return buildStructuredFallbackSummary(buildRuleBasedCompactionSummary(args.messages));
  }
}

export const __testing = {
  setGenerateCompactionSummaryOverride(override?: TestSummaryOverride) {
    globalThis.__oceankingAgentCompactionSummaryOverride = override;
  },
  buildRuleBasedCompactionSummary,
  splitMessagesIntoChunks,
  hasRequiredHeadings,
  extractExactIdentifierHints,
};
