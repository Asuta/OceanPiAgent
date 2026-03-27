import assert from "node:assert/strict";
import test from "node:test";
import { shouldFallbackToResponsesReplay } from "@/lib/ai/provider-compat";

test("shouldFallbackToResponsesReplay inspects nested error causes", () => {
  const error = new Error("Top level failure", {
    cause: new Error("400 status code: bad request: previous_response_id is not supported"),
  });

  assert.equal(shouldFallbackToResponsesReplay(error), true);
});

test("shouldFallbackToResponsesReplay ignores unrelated errors", () => {
  assert.equal(shouldFallbackToResponsesReplay(new Error("socket hang up")), false);
});
