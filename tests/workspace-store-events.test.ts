import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultWorkspaceState } from "@/lib/server/workspace-state";
import { mutateWorkspace, subscribeWorkspaceEvents } from "@/lib/server/workspace-store";

test("workspace store broadcasts patch events after mutation", async () => {
  const seenEventTypes: string[] = [];
  const unsubscribe = subscribeWorkspaceEvents((event) => {
    seenEventTypes.push(event.type);
  });

  try {
    await mutateWorkspace((state) => ({
      ...createDefaultWorkspaceState(),
      rooms: state.rooms,
      agentStates: state.agentStates,
    }));
  } finally {
    unsubscribe();
  }

  assert.deepEqual(seenEventTypes, ["patch"]);
});
