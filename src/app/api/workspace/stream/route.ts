import { ensureChannelRuntimeStarted } from "@/lib/server/channel-runtime";
import { ensureCronDispatcherStarted } from "@/lib/server/cron-dispatcher";
import { loadWorkspaceEnvelope, subscribeWorkspaceEnvelopes } from "@/lib/server/workspace-store";

export const runtime = "nodejs";

function encodeEnvelope(envelope: Awaited<ReturnType<typeof loadWorkspaceEnvelope>>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(envelope)}\n\n`);
}

export async function GET(request: Request) {
  ensureCronDispatcherStarted();
  ensureChannelRuntimeStarted();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const initialEnvelope = await loadWorkspaceEnvelope();
      controller.enqueue(encodeEnvelope(initialEnvelope));

      const unsubscribe = subscribeWorkspaceEnvelopes((envelope) => {
        controller.enqueue(encodeEnvelope(envelope));
      });
      const heartbeat = setInterval(() => {
        controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
      }, 20_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
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
