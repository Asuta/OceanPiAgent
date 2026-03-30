import assert from "node:assert/strict";
import test from "node:test";
import { claimRoomStream, combineAbortSignals } from "@/lib/server/room-stream-control";

test("claimRoomStream aborts the previous owner when a newer stream takes over", () => {
  const first = claimRoomStream("room-1");
  let aborted = false;
  first.signal.addEventListener("abort", () => {
    aborted = true;
  });

  const second = claimRoomStream("room-1");

  assert.equal(aborted, true);
  assert.equal(second.signal.aborted, false);
  second.release();
});

test("combineAbortSignals aborts when any source signal aborts", () => {
  const first = new AbortController();
  const second = new AbortController();
  const combined = combineAbortSignals([first.signal, second.signal]);

  second.abort(new Error("stop"));

  assert.equal(combined.aborted, true);
});
