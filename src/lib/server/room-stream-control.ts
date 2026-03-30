type ActiveRoomStream = {
  streamId: string;
  controller: AbortController;
};

declare global {
  var __oceankingActiveRoomStreams: Map<string, ActiveRoomStream> | undefined;
}

const activeRoomStreams = globalThis.__oceankingActiveRoomStreams ?? new Map<string, ActiveRoomStream>();
globalThis.__oceankingActiveRoomStreams = activeRoomStreams;

function createStreamId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function claimRoomStream(roomId: string): {
  streamId: string;
  signal: AbortSignal;
  release: () => void;
} {
  const previous = activeRoomStreams.get(roomId);
  if (previous) {
    previous.controller.abort(new Error("Room stream was taken over by a newer request."));
  }

  const streamId = createStreamId();
  const controller = new AbortController();
  activeRoomStreams.set(roomId, { streamId, controller });

  return {
    streamId,
    signal: controller.signal,
    release: () => {
      const current = activeRoomStreams.get(roomId);
      if (current?.streamId === streamId) {
        activeRoomStreams.delete(roomId);
      }
    },
  };
}

export function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const abortWithReason = (signal: AbortSignal) => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(signal.reason);
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abortWithReason(signal);
      break;
    }

    signal.addEventListener("abort", () => abortWithReason(signal), { once: true });
  }

  return controller.signal;
}
