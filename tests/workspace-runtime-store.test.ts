import assert from "node:assert/strict";
import test from "node:test";

test("workspace runtime store emits runtime snapshots and patches for tool lifecycle", async () => {
  const runtimeStore = await import("../src/lib/server/workspace-runtime-store");
  runtimeStore.resetWorkspaceRuntimeStateForTest?.();

  const initial = runtimeStore.loadWorkspaceRuntimeEnvelope?.();
  assert.deepEqual(initial?.state.agentStates ?? {}, {});

  const seenEventTypes: string[] = [];
  const unsubscribe = runtimeStore.subscribeWorkspaceRuntimeEvents?.((event: { type: string }) => {
    seenEventTypes.push(event.type);
  });

  runtimeStore.startAgentToolRuntime?.({
    agentId: "concierge",
    roomId: "room-1",
    turnId: "turn-1",
    toolCallId: "tool-1",
    toolName: "web_search",
  });
  let current = runtimeStore.loadWorkspaceRuntimeEnvelope?.();
  assert.equal(current?.state.agentStates.concierge?.toolName, "web_search");

  runtimeStore.finishAgentToolRuntime?.({
    agentId: "concierge",
    toolCallId: "tool-1",
  });
  current = runtimeStore.loadWorkspaceRuntimeEnvelope?.();
  assert.equal(current?.state.agentStates.concierge, undefined);

  unsubscribe?.();

  assert.deepEqual(seenEventTypes, ["runtime-patch", "runtime-patch"]);
});
