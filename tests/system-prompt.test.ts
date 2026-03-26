import assert from "node:assert/strict";
import test from "node:test";
import { buildRoomBridgePrompt, buildSystemPrompt } from "@/lib/ai/system-prompt";

test("buildSystemPrompt advertises bash as a base tool", () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /bash, web_fetch, and custom_command/);
  assert.match(prompt, /bash runs an unrestricted shell command on the server/);
});

test("buildRoomBridgePrompt mentions bash for room agents", () => {
  const prompt = buildRoomBridgePrompt({
    roomTitle: "Test Room",
    roomId: "room-1",
    agentLabel: "Harbor Concierge",
  });

  assert.match(prompt, /base tools such as bash, web_fetch, and custom_command/);
  assert.match(prompt, /bash runs on the server, not in the human-visible chat UI/);
});
