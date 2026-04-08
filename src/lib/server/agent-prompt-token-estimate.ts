import { buildRoomBridgePrompt } from "@/lib/ai/system-prompt";
import { getChatCompletionsTools, getLegacyChatCompletionsFunctions, getResponsesTools } from "@/lib/ai/tools";
import type { ChatSettings, MessageImageAttachment, ProviderCompatibility, RoomAgentId } from "@/lib/chat/types";
import { createAgentSharedState, createAttachedRoomDefinition, getActiveRooms, getRoomAgent } from "@/lib/server/workspace-state";
import { loadWorkspaceEnvelope } from "@/lib/server/workspace-store";
import { estimateTokens } from "./lcm/estimate-tokens";

type PromptHistoryMessage = {
  role: "user" | "assistant";
  attachments?: MessageImageAttachment[];
};

export interface AgentPromptTokenEstimate {
  totalTokens: number;
  contextTokens: number;
  promptOverheadTokens: number;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  attachmentTokens: number;
}

function estimateAttachmentPayloadTokens(attachments: MessageImageAttachment[]): number {
  return attachments.reduce((total, attachment) => total + Math.ceil(Math.max(0, attachment.sizeBytes) / 3), 0);
}

function buildToolSchemaPayload(settings: ChatSettings, compatibility: ProviderCompatibility | null): unknown {
  if (settings.apiFormat === "responses") {
    return getResponsesTools("room");
  }

  if (compatibility?.chatCompletionsToolStyle === "functions") {
    return getLegacyChatCompletionsFunctions("room");
  }

  return getChatCompletionsTools("room");
}

export async function estimateAgentPromptTokens(args: {
  agentId: RoomAgentId;
  contextTokens: number;
  history: PromptHistoryMessage[];
  systemPromptAddition?: string;
}): Promise<AgentPromptTokenEstimate> {
  const workspace = await loadWorkspaceEnvelope().catch(() => null);
  const agentState = workspace?.state.agentStates[args.agentId] ?? createAgentSharedState();
  const settings = agentState.settings;
  const compatibility = agentState.compatibility;
  const attachedRooms = workspace
    ? getActiveRooms(workspace.state.rooms)
        .filter((room) => room.participants.some((participant) => participant.runtimeKind === "agent" && participant.agentId === args.agentId))
        .map((room) => createAttachedRoomDefinition(room, args.agentId))
    : [];
  const candidateRooms = attachedRooms.length > 0 ? attachedRooms : [null];
  const agent = getRoomAgent(args.agentId);
  const operatorPrompt = [settings.systemPrompt, args.systemPromptAddition].filter(Boolean).join("\n\n");
  const systemPromptTokens = candidateRooms.reduce((maxTokens, room) => {
    const prompt = buildRoomBridgePrompt({
      operatorPrompt,
      roomId: room?.id,
      roomTitle: room?.title,
      agentLabel: agent.label,
      agentInstruction: agent.instruction,
      attachedRooms,
    });
    return Math.max(maxTokens, estimateTokens(prompt));
  }, 0);
  const toolSchemaTokens = estimateTokens(JSON.stringify(buildToolSchemaPayload(settings, compatibility)));
  const attachmentTokens = args.history.reduce(
    (total, message) => total + (message.role === "user" && message.attachments?.length ? estimateAttachmentPayloadTokens(message.attachments) : 0),
    0,
  );
  const promptOverheadTokens = systemPromptTokens + toolSchemaTokens + attachmentTokens;

  return {
    totalTokens: args.contextTokens + promptOverheadTokens,
    contextTokens: args.contextTokens,
    promptOverheadTokens,
    systemPromptTokens,
    toolSchemaTokens,
    attachmentTokens,
  };
}
