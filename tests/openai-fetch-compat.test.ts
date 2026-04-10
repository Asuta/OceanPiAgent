import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenAiFetchCompatibilityHeaders,
  shouldUseOpenAiFetchCompatibility,
} from "@/lib/ai/openai-fetch-compat";

test("openai fetch compatibility only applies to lucen hosts", () => {
  assert.equal(shouldUseOpenAiFetchCompatibility("https://lucen.cc/v1"), true);
  assert.equal(shouldUseOpenAiFetchCompatibility("https://api.openai.com/v1"), false);
  assert.equal(shouldUseOpenAiFetchCompatibility("not-a-url"), false);
});

test("openai fetch compatibility strips SDK headers and adds provider metadata", () => {
  const headers = buildOpenAiFetchCompatibilityHeaders({
    Authorization: "Bearer test-key",
    "User-Agent": "OpenAI/JS 1.0.0",
    "X-Stainless-Lang": "js",
  });

  assert.equal(headers.get("authorization"), "Bearer test-key");
  assert.equal(headers.get("x-api-key"), "test-key");
  assert.equal(headers.get("user-agent"), null);
  assert.equal(headers.get("x-stainless-lang"), null);
  assert.equal(headers.get("http-referer"), "http://localhost:3000");
  assert.equal(headers.get("x-title"), "Quiet Wizard");
});
