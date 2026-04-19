import assert from "node:assert/strict";
import test from "node:test";
import {
  createMotionTrack,
  projectMotionTrack,
} from "@/components/workspace/agent-world-motion";

test("projectMotionTrack advances along a multi-segment path at constant speed", () => {
  const track = createMotionTrack({
    path: [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
    ],
    speedUnitsPerSecond: 10,
    startedAtMs: 0,
  });

  const firstLeg = projectMotionTrack(track, 500);
  const secondLeg = projectMotionTrack(track, 1_500);

  assert.deepEqual(firstLeg.position, { x: 15, y: 10 });
  assert.deepEqual(secondLeg.position, { x: 20, y: 15 });
  assert.equal(secondLeg.arrived, false);
});

test("createMotionTrack can be replanned from an agent's live position", () => {
  const original = createMotionTrack({
    path: [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
    ],
    speedUnitsPerSecond: 10,
    startedAtMs: 0,
  });
  const current = projectMotionTrack(original, 600);

  const replanned = createMotionTrack({
    path: [
      current.position,
      { x: current.position.x, y: 20 },
      { x: 20, y: 20 },
    ],
    speedUnitsPerSecond: 10,
    startedAtMs: 600,
  });

  assert.deepEqual(replanned.path[0], current.position);
  assert.deepEqual(projectMotionTrack(replanned, 1_100).position, { x: 16, y: 15 });
});
