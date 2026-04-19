import assert from "node:assert/strict";
import test from "node:test";
import {
  findNearestWalkablePoint,
  findWorldPath,
  isWorldPointBlocked,
  type PathfindingWorld,
} from "@/components/workspace/agent-world-pathfinding";

function createWorld(overrides?: Partial<PathfindingWorld>): PathfindingWorld {
  return {
    width: 100,
    height: 100,
    cellSize: 2,
    obstacles: [],
    ...overrides,
  };
}

test("findWorldPath routes around a blocking obstacle instead of crossing through it", () => {
  const world = createWorld({
    obstacles: [
      { x: 46, y: 34, width: 8, height: 28 },
    ],
  });

  const path = findWorldPath({
    world,
    start: { x: 40, y: 50 },
    target: { x: 60, y: 50 },
  });

  assert.ok(path);
  assert.deepEqual(path?.[0], { x: 40, y: 50 });
  assert.deepEqual(path?.at(-1), { x: 60, y: 50 });
  assert.equal(path?.some((point) => point.y < 34 || point.y > 62), true);
  assert.equal(path?.some((point) => isWorldPointBlocked(world, point)), false);
});

test("findNearestWalkablePoint pushes a blocked target out to the nearest walkable point", () => {
  const world = createWorld({
    obstacles: [
      { x: 58, y: 30, width: 10, height: 10 },
    ],
  });

  const target = findNearestWalkablePoint(world, { x: 62, y: 34 });

  assert.ok(target);
  assert.equal(isWorldPointBlocked(world, target!), false);
  assert.notDeepEqual(target, { x: 62, y: 34 });
});
