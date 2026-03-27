import type { EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import type { FeishuChannelConfig } from "@/lib/server/channels/feishu/config";
import { createFeishuWsClient } from "@/lib/server/channels/feishu/client";

export async function startFeishuWebSocketTransport(args: {
  config: FeishuChannelConfig;
  eventDispatcher: EventDispatcher;
  signal?: AbortSignal;
}): Promise<void> {
  const wsClient = createFeishuWsClient(args.config);

  await new Promise<void>((resolve, reject) => {
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      args.signal?.removeEventListener("abort", handleAbort);
      try {
        (wsClient as WSClient).close();
      } catch {
        // Ignore close errors during shutdown.
      }
    };

    const handleAbort = () => {
      cleanup();
      resolve();
    };

    if (args.signal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    args.signal?.addEventListener("abort", handleAbort, { once: true });

    try {
      wsClient.start({ eventDispatcher: args.eventDispatcher });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
