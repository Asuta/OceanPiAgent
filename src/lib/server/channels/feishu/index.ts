import type { EventDispatcher } from "@larksuiteoapi/node-sdk";
import type { ExternalInboundMessage } from "@/lib/server/channels/types";
import { getFeishuChannelConfig, type FeishuChannelConfig } from "@/lib/server/channels/feishu/config";
import { createFeishuEventDispatcher } from "@/lib/server/channels/feishu/client";
import { parseFeishuInboundMessage } from "@/lib/server/channels/feishu/inbound";
import { startFeishuWebSocketTransport } from "@/lib/server/channels/feishu/transport-websocket";

export interface FeishuChannelRuntimeCallbacks {
  onStarted?: () => void;
  onError?: (error: unknown) => void;
  onInboundMessage?: (message: ExternalInboundMessage) => Promise<void>;
  onLog?: (args: {
    level: "info" | "warn" | "error";
    message: string;
    details?: Record<string, string | number | boolean | null | undefined>;
  }) => void;
}

function registerInboundHandlers(dispatcher: EventDispatcher, config: FeishuChannelConfig, callbacks: FeishuChannelRuntimeCallbacks): void {
  dispatcher.register({
    "im.message.receive_v1": async (event: unknown) => {
      const parsed = await parseFeishuInboundMessage(event, config, {
        logger: callbacks.onLog,
      });
      if (!parsed) {
        return;
      }
      if (config.allowOpenIds.length > 0 && !config.allowOpenIds.includes(parsed.senderId)) {
        callbacks.onLog?.({
          level: "warn",
          message: "Ignored Feishu message from non-allowlisted sender",
          details: {
            peerId: parsed.peerId,
            senderId: parsed.senderId,
          },
        });
        return;
      }
      await callbacks.onInboundMessage?.(parsed);
    },
  });
}

export async function startFeishuChannelRuntime(signal?: AbortSignal, callbacks: FeishuChannelRuntimeCallbacks = {}): Promise<void> {
  const config = getFeishuChannelConfig();
  if (!config.enabled) {
    return;
  }

  try {
    const dispatcher = createFeishuEventDispatcher();
    registerInboundHandlers(dispatcher, config, callbacks);
    callbacks.onLog?.({
      level: "info",
      message: "Starting Feishu WebSocket runtime",
      details: {
        accountId: config.accountId,
        defaultAgentId: config.defaultAgentId,
        allowlistEnabled: config.allowOpenIds.length > 0,
      },
    });
    callbacks.onStarted?.();
    await startFeishuWebSocketTransport({
      config,
      eventDispatcher: dispatcher,
      signal,
    });
  } catch (error) {
    callbacks.onError?.(error);
    throw error;
  }
}
