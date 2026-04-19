import type { WorldPoint } from "@/components/workspace/agent-world-pathfinding";

export interface MotionTrack {
  path: WorldPoint[];
  startedAtMs: number;
  speedUnitsPerSecond: number;
  segmentLengths: number[];
  totalLength: number;
}

export interface MotionProjection {
  position: WorldPoint;
  arrived: boolean;
  distanceTraveled: number;
  progress: number;
}

function distanceBetweenPoints(left: WorldPoint, right: WorldPoint) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function lerp(start: number, end: number, ratio: number) {
  return start + (end - start) * ratio;
}

export function createMotionTrack(args: {
  path: WorldPoint[];
  speedUnitsPerSecond: number;
  startedAtMs: number;
}): MotionTrack {
  const path = args.path.filter((point, index) => {
    if (index === 0) {
      return true;
    }
    return distanceBetweenPoints(point, args.path[index - 1]!) > 0.001;
  });

  const safePath = path.length > 0 ? path : [{ x: 0, y: 0 }];
  const segmentLengths = safePath.slice(0, -1).map((point, index) => distanceBetweenPoints(point, safePath[index + 1]!));
  const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);

  return {
    path: safePath,
    startedAtMs: args.startedAtMs,
    speedUnitsPerSecond: args.speedUnitsPerSecond,
    segmentLengths,
    totalLength,
  };
}

export function projectMotionTrack(track: MotionTrack, atMs: number): MotionProjection {
  const firstPoint = track.path[0] ?? { x: 0, y: 0 };
  if (track.totalLength <= 0 || track.path.length <= 1) {
    return {
      position: firstPoint,
      arrived: true,
      distanceTraveled: 0,
      progress: 1,
    };
  }

  const elapsedMs = Math.max(0, atMs - track.startedAtMs);
  const distanceTraveled = Math.min(track.totalLength, (elapsedMs / 1_000) * track.speedUnitsPerSecond);

  if (distanceTraveled >= track.totalLength) {
    return {
      position: track.path.at(-1)!,
      arrived: true,
      distanceTraveled: track.totalLength,
      progress: 1,
    };
  }

  let traversed = 0;
  for (let index = 0; index < track.segmentLengths.length; index += 1) {
    const segmentLength = track.segmentLengths[index]!;
    const nextTraversed = traversed + segmentLength;
    if (distanceTraveled > nextTraversed) {
      traversed = nextTraversed;
      continue;
    }

    const segmentProgress = segmentLength === 0 ? 1 : (distanceTraveled - traversed) / segmentLength;
    const start = track.path[index]!;
    const end = track.path[index + 1]!;

    return {
      position: {
        x: lerp(start.x, end.x, segmentProgress),
        y: lerp(start.y, end.y, segmentProgress),
      },
      arrived: false,
      distanceTraveled,
      progress: distanceTraveled / track.totalLength,
    };
  }

  return {
    position: track.path.at(-1)!,
    arrived: true,
    distanceTraveled: track.totalLength,
    progress: 1,
  };
}
