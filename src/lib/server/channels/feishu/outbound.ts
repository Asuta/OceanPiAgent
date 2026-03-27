import type { ExternalOutboundMessage } from "@/lib/server/channels/types";
import type { FeishuChannelConfig } from "@/lib/server/channels/feishu/config";
import { getFeishuRestClient } from "@/lib/server/channels/feishu/client";

const FEISHU_TEXT_CHUNK_LIMIT = 1800;

function splitIntoChunks(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > FEISHU_TEXT_CHUNK_LIMIT) {
    chunks.push(remaining.slice(0, FEISHU_TEXT_CHUNK_LIMIT));
    remaining = remaining.slice(FEISHU_TEXT_CHUNK_LIMIT);
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function assertFeishuResponse(response: { code?: number; msg?: string }): void {
  if (typeof response.code === "number" && response.code !== 0) {
    throw new Error(response.msg || `Feishu send failed with code ${response.code}.`);
  }
}

export async function deliverFeishuMessages(messages: ExternalOutboundMessage[], config: FeishuChannelConfig): Promise<void> {
  const client = getFeishuRestClient(config);
  for (const message of messages) {
    if (message.channel !== "feishu" || message.peerKind !== "direct") {
      continue;
    }

    for (const chunk of splitIntoChunks(message.content)) {
      const response = await client.im.message.create({
        params: {
          receive_id_type: "open_id",
        },
        data: {
          receive_id: message.peerId,
          msg_type: "text",
          content: JSON.stringify({ text: chunk }),
        },
      });
      assertFeishuResponse(response);
    }
  }
}
