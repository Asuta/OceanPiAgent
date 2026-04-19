import { useEffect } from "react";
import type { RoomWorkspaceState } from "@/lib/chat/types";
import type { WorkspaceStreamEvent } from "@/lib/chat/workspace-stream";

type MutableRef<T> = {
  current: T;
};

export function useWorkspaceStreamSync(args: {
  hydrated: boolean;
  workspaceVersionRef: MutableRef<number>;
  workspaceRuntimeVersionRef: MutableRef<number>;
  applyWorkspaceStreamEvent: (event: WorkspaceStreamEvent) => void;
  refreshWorkspaceFromServer: () => Promise<{ version?: number; state?: RoomWorkspaceState } | null>;
}) {
  const { hydrated, workspaceVersionRef, workspaceRuntimeVersionRef, applyWorkspaceStreamEvent, refreshWorkspaceFromServer } = args;

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    const workspaceEvents = new EventSource("/api/workspace/stream");
    workspaceEvents.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as WorkspaceStreamEvent;
        if (payload.type === "snapshot" && typeof payload.version === "number" && payload.version >= workspaceVersionRef.current) {
          applyWorkspaceStreamEvent(payload);
          return;
        }

        if (payload.type === "patch" && typeof payload.version === "number" && payload.version > workspaceVersionRef.current) {
          applyWorkspaceStreamEvent(payload);
          return;
        }

        if (payload.type === "runtime-snapshot") {
          applyWorkspaceStreamEvent(payload);
          return;
        }

        if (payload.type === "runtime-patch" && payload.runtimeVersion > workspaceRuntimeVersionRef.current) {
          applyWorkspaceStreamEvent(payload);
        }
      } catch {
        // Ignore malformed SSE payloads and wait for the next envelope.
      }
    };

    workspaceEvents.onerror = () => {
      void refreshWorkspaceFromServer();
    };

    return () => {
      workspaceEvents.close();
    };
  }, [applyWorkspaceStreamEvent, hydrated, refreshWorkspaceFromServer, workspaceRuntimeVersionRef, workspaceVersionRef]);
}
