import assert from "node:assert/strict";
import test from "node:test";
import { resolveActualThinkingLevel } from "@/lib/ai/pi-model-catalog";
import { parseRoomWorkspaceState } from "@/lib/chat/schemas";
import { coerceCompactionTokenThreshold, coerceThinkingLevel } from "@/lib/chat/types";

test("coerceThinkingLevel maps legacy minimal to none", () => {
  assert.equal(coerceThinkingLevel("minimal"), "none");
  assert.equal(coerceThinkingLevel("none"), "none");
});

test("coerceCompactionTokenThreshold clamps to supported range", () => {
  assert.equal(coerceCompactionTokenThreshold(undefined), 200_000);
  assert.equal(coerceCompactionTokenThreshold(999), 1_000);
  assert.equal(coerceCompactionTokenThreshold(250_400), 250_400);
  assert.equal(coerceCompactionTokenThreshold(2_500_000), 2_000_000);
});

test("parseRoomWorkspaceState normalizes legacy minimal thinking level", () => {
  const workspace = parseRoomWorkspaceState({
    rooms: [],
    activeRoomId: "room-1",
    agentStates: {
      concierge: {
        settings: {
          modelConfigId: null,
          apiFormat: "responses",
          model: "gpt-5.4",
          systemPrompt: "",
          providerMode: "auto",
          compactionTokenThreshold: 250_000,
          maxToolLoopSteps: 10,
          thinkingLevel: "minimal",
          enabledSkillIds: [],
        },
        agentTurns: [],
        resolvedModel: "gpt-5.4",
        compatibility: null,
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    },
  });

  assert.equal(workspace.agentStates.concierge.settings.thinkingLevel, "none");
  assert.equal(workspace.agentStates.concierge.settings.compactionTokenThreshold, 250_000);
});

test("resolveActualThinkingLevel preserves distinct off and none levels for reasoning models", () => {
  const capability = { reasoning: true, supportsXhigh: true, knownModel: true };

  assert.equal(resolveActualThinkingLevel("off", capability), "off");
  assert.equal(resolveActualThinkingLevel("none", capability), "none");
  assert.equal(resolveActualThinkingLevel("low", capability), "low");
});
