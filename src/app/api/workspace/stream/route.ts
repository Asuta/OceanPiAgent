import { ensureChannelRuntimeStarted } from "@/lib/server/channel-runtime";
import { ensureCronDispatcherStarted } from "@/lib/server/cron-dispatcher";
import type { WorkspaceStreamEvent } from "@/lib/chat/workspace-stream";
import { loadWorkspaceEnvelope, subscribeWorkspaceEvents } from "@/lib/server/workspace-store";
import { loadWorkspaceRuntimeEnvelope, subscribeWorkspaceRuntimeEvents } from "@/lib/server/workspace-runtime-store";

export const runtime = "nodejs";

function encodeEvent(event: WorkspaceStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function GET(request: Request) {
  ensureCronDispatcherStarted();
  ensureChannelRuntimeStarted();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const initialEnvelope = await loadWorkspaceEnvelope();
      controller.enqueue(encodeEvent({
        type: "snapshot",
        version: initialEnvelope.version,
        updatedAt: initialEnvelope.updatedAt,
        state: initialEnvelope.state,
      }));
      const initialRuntimeEnvelope = loadWorkspaceRuntimeEnvelope();
      controller.enqueue(encodeEvent({
        type: "runtime-snapshot",
        runtimeVersion: initialRuntimeEnvelope.runtimeVersion,
        updatedAt: initialRuntimeEnvelope.updatedAt,
        state: initialRuntimeEnvelope.state,
      }));

      const unsubscribe = subscribeWorkspaceEvents((event) => {
        controller.enqueue(encodeEvent(event));
      });
      const unsubscribeRuntime = subscribeWorkspaceRuntimeEvents((event) => {
        controller.enqueue(encodeEvent(event));
      });
      const heartbeat = setInterval(() => {
        controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
      }, 20_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribeRuntime();
        controller.close();
      }, { once: true });
    },
    cancel() {
      return undefined;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
