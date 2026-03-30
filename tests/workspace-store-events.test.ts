import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultWorkspaceState } from "@/lib/server/workspace-state";
import { mutateWorkspace, subscribeWorkspaceEnvelopes } from "@/lib/server/workspace-store";

test("workspace store broadcasts envelopes after mutation", async () => {
  const seenVersions: number[] = [];
  const unsubscribe = subscribeWorkspaceEnvelopes((envelope) => {
    seenVersions.push(envelope.version);
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

  assert.equal(seenVersions.length > 0, true);
});
