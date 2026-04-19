export interface WorldPoint {
  x: number;
  y: number;
}

export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PathfindingWorld {
  width: number;
  height: number;
  cellSize: number;
  obstacles: WorldRect[];
}

interface GridPoint {
  x: number;
  y: number;
}

interface FindWorldPathArgs {
  world: PathfindingWorld;
  start: WorldPoint;
  target: WorldPoint;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function distanceBetweenPoints(left: WorldPoint, right: WorldPoint) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function pointsEqual(left: GridPoint, right: GridPoint) {
  return left.x === right.x && left.y === right.y;
}

function gridKey(point: GridPoint) {
  return `${point.x},${point.y}`;
}

function getGridWidth(world: PathfindingWorld) {
  return Math.max(1, Math.ceil(world.width / world.cellSize));
}

function getGridHeight(world: PathfindingWorld) {
  return Math.max(1, Math.ceil(world.height / world.cellSize));
}

function clampWorldPoint(world: PathfindingWorld, point: WorldPoint): WorldPoint {
  return {
    x: clamp(point.x, 0, world.width),
    y: clamp(point.y, 0, world.height),
  };
}

function getCellRect(world: PathfindingWorld, cell: GridPoint): WorldRect {
  return {
    x: cell.x * world.cellSize,
    y: cell.y * world.cellSize,
    width: world.cellSize,
    height: world.cellSize,
  };
}

function rectsOverlap(left: WorldRect, right: WorldRect) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function isCellBlocked(world: PathfindingWorld, cell: GridPoint) {
  if (cell.x < 0 || cell.y < 0 || cell.x >= getGridWidth(world) || cell.y >= getGridHeight(world)) {
    return true;
  }

  const rect = getCellRect(world, cell);
  return world.obstacles.some((obstacle) => rectsOverlap(rect, obstacle));
}

function pointToCell(world: PathfindingWorld, point: WorldPoint): GridPoint {
  const clamped = clampWorldPoint(world, point);
  return {
    x: clamp(Math.floor(clamped.x / world.cellSize), 0, getGridWidth(world) - 1),
    y: clamp(Math.floor(clamped.y / world.cellSize), 0, getGridHeight(world) - 1),
  };
}

function cellToWorldPoint(world: PathfindingWorld, cell: GridPoint): WorldPoint {
  return {
    x: clamp(cell.x * world.cellSize + world.cellSize / 2, 0, world.width),
    y: clamp(cell.y * world.cellSize + world.cellSize / 2, 0, world.height),
  };
}

function getNeighborCells(world: PathfindingWorld, cell: GridPoint): GridPoint[] {
  const candidates: GridPoint[] = [
    { x: cell.x + 1, y: cell.y },
    { x: cell.x - 1, y: cell.y },
    { x: cell.x, y: cell.y + 1 },
    { x: cell.x, y: cell.y - 1 },
  ];

  return candidates.filter((candidate) => !isCellBlocked(world, candidate));
}

function hasLineOfSight(world: PathfindingWorld, start: WorldPoint, end: WorldPoint) {
  const distance = distanceBetweenPoints(start, end);
  if (distance === 0) {
    return !isWorldPointBlocked(world, start);
  }

  const stepLength = Math.max(world.cellSize / 2, 0.5);
  const steps = Math.max(1, Math.ceil(distance / stepLength));

  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps;
    const sample = {
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
    };
    if (isWorldPointBlocked(world, sample)) {
      return false;
    }
  }

  return true;
}

function simplifyWorldPath(world: PathfindingWorld, points: WorldPoint[]) {
  if (points.length <= 2) {
    return points;
  }

  const deduped = points.filter((point, index) => {
    if (index === 0) {
      return true;
    }
    return distanceBetweenPoints(point, points[index - 1]!) > 0.01;
  });

  if (deduped.length <= 2) {
    return deduped;
  }

  const simplified: WorldPoint[] = [deduped[0]!];
  let anchorIndex = 0;
  let probeIndex = 2;

  while (probeIndex < deduped.length) {
    const anchor = deduped[anchorIndex]!;
    const probe = deduped[probeIndex]!;
    if (hasLineOfSight(world, anchor, probe)) {
      probeIndex += 1;
      continue;
    }

    const previous = deduped[probeIndex - 1]!;
    simplified.push(previous);
    anchorIndex = probeIndex - 1;
    probeIndex = anchorIndex + 2;
  }

  simplified.push(deduped.at(-1)!);
  return simplified;
}

function reconstructCellPath(cameFrom: Map<string, GridPoint>, current: GridPoint) {
  const path: GridPoint[] = [current];
  let cursor = current;

  while (cameFrom.has(gridKey(cursor))) {
    cursor = cameFrom.get(gridKey(cursor))!;
    path.unshift(cursor);
  }

  return path;
}

export function isWorldPointBlocked(world: PathfindingWorld, point: WorldPoint) {
  if (point.x < 0 || point.y < 0 || point.x > world.width || point.y > world.height) {
    return true;
  }

  return world.obstacles.some(
    (obstacle) =>
      point.x >= obstacle.x &&
      point.x <= obstacle.x + obstacle.width &&
      point.y >= obstacle.y &&
      point.y <= obstacle.y + obstacle.height,
  );
}

export function findNearestWalkablePoint(world: PathfindingWorld, point: WorldPoint): WorldPoint | null {
  const clamped = clampWorldPoint(world, point);
  if (!isWorldPointBlocked(world, clamped)) {
    return clamped;
  }

  const start = pointToCell(world, clamped);
  const queue: GridPoint[] = [start];
  const visited = new Set<string>([gridKey(start)]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!isCellBlocked(world, current)) {
      return cellToWorldPoint(world, current);
    }

    const candidates: GridPoint[] = [
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 },
    ];

    for (const candidate of candidates) {
      const key = gridKey(candidate);
      if (visited.has(key)) {
        continue;
      }
      if (candidate.x < 0 || candidate.y < 0 || candidate.x >= getGridWidth(world) || candidate.y >= getGridHeight(world)) {
        continue;
      }

      visited.add(key);
      queue.push(candidate);
    }
  }

  return null;
}

export function findWorldPath(args: FindWorldPathArgs): WorldPoint[] | null {
  const start = findNearestWalkablePoint(args.world, args.start);
  const target = findNearestWalkablePoint(args.world, args.target);

  if (!start || !target) {
    return null;
  }

  if (hasLineOfSight(args.world, start, target)) {
    return [start, target];
  }

  const startCell = pointToCell(args.world, start);
  const targetCell = pointToCell(args.world, target);

  if (pointsEqual(startCell, targetCell)) {
    return [start, target];
  }

  const openSet: GridPoint[] = [startCell];
  const cameFrom = new Map<string, GridPoint>();
  const gScore = new Map<string, number>([[gridKey(startCell), 0]]);
  const fScore = new Map<string, number>([[gridKey(startCell), distanceBetweenPoints(startCell, targetCell)]]);

  while (openSet.length > 0) {
    let currentIndex = 0;
    for (let index = 1; index < openSet.length; index += 1) {
      const best = fScore.get(gridKey(openSet[currentIndex]!)) ?? Number.POSITIVE_INFINITY;
      const candidate = fScore.get(gridKey(openSet[index]!)) ?? Number.POSITIVE_INFINITY;
      if (candidate < best) {
        currentIndex = index;
      }
    }

    const current = openSet.splice(currentIndex, 1)[0]!;
    if (pointsEqual(current, targetCell)) {
      const cellPath = reconstructCellPath(cameFrom, current);
      const worldPath = [
        start,
        ...cellPath.slice(1, -1).map((cell) => cellToWorldPoint(args.world, cell)),
        target,
      ];
      return simplifyWorldPath(args.world, worldPath);
    }

    const currentG = gScore.get(gridKey(current)) ?? Number.POSITIVE_INFINITY;
    for (const neighbor of getNeighborCells(args.world, current)) {
      const tentativeG = currentG + 1;
      const neighborKey = gridKey(neighbor);
      const existingG = gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY;
      if (tentativeG >= existingG) {
        continue;
      }

      cameFrom.set(neighborKey, current);
      gScore.set(neighborKey, tentativeG);
      fScore.set(neighborKey, tentativeG + distanceBetweenPoints(neighbor, targetCell));
      if (!openSet.some((entry) => pointsEqual(entry, neighbor))) {
        openSet.push(neighbor);
      }
    }
  }

  return null;
}
