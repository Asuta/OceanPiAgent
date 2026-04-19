import type { PathfindingWorld, WorldRect } from "@/components/workspace/agent-world-pathfinding";

export type WorldZoneId = "lounge" | "workspace";

export interface WorldZone {
  id: WorldZoneId;
  label: string;
  shortLabel: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentWorldPoint {
  x: number;
  y: number;
  label: string;
}

export interface PixelOfficeDeskLayout {
  desk: AgentWorldPoint;
  workstation: AgentWorldPoint;
  obstacles: WorldRect[];
}

export interface PixelOfficeLayout {
  width: number;
  height: number;
  cellSize: number;
  zones: WorldZone[];
  loungeWaypoints: AgentWorldPoint[];
  desks: PixelOfficeDeskLayout[];
  world: PathfindingWorld;
}

export const PIXEL_OFFICE_WIDTH = 100;
export const PIXEL_OFFICE_HEIGHT = 100;
export const PIXEL_OFFICE_CELL_SIZE = 2;

export const PIXEL_OFFICE_ZONES: WorldZone[] = [
  { id: "lounge", label: "Lounge", shortLabel: "休息区", x: 4, y: 12, width: 40, height: 74 },
  { id: "workspace", label: "Work Room", shortLabel: "工作区", x: 52, y: 12, width: 44, height: 74 },
];

export const PIXEL_OFFICE_LOUNGE_WAYPOINTS: AgentWorldPoint[] = [
  { x: 14, y: 30, label: "Lounge path A" },
  { x: 22, y: 48, label: "Lounge path B" },
  { x: 32, y: 28, label: "Lounge path C" },
  { x: 18, y: 68, label: "Lounge path D" },
  { x: 35, y: 62, label: "Lounge path E" },
  { x: 28, y: 78, label: "Lounge path F" },
];

function createDeskAnchor(index: number): AgentWorldPoint {
  const columns = 3;
  const row = Math.floor(index / columns);
  const column = index % columns;
  return {
    x: 62 + column * 11,
    y: 34 + row * 22,
    label: `Desk ${index + 1}`,
  };
}

function createDeskObstacles(desk: AgentWorldPoint): WorldRect[] {
  return [
    {
      x: desk.x - 4.5,
      y: desk.y - 5.5,
      width: 8.6,
      height: 5.8,
    },
    {
      x: desk.x - 2.7,
      y: desk.y - 4.3,
      width: 3.1,
      height: 2.5,
    },
    {
      x: desk.x + 1.8,
      y: desk.y + 0.6,
      width: 2.8,
      height: 3.4,
    },
  ];
}

function createDeskLayout(index: number): PixelOfficeDeskLayout {
  const desk = createDeskAnchor(index);
  return {
    desk,
    workstation: {
      x: desk.x - 6,
      y: desk.y + 1,
      label: `${desk.label} workstation`,
    },
    obstacles: createDeskObstacles(desk),
  };
}

export function createPixelOfficeLayout(agentCount: number): PixelOfficeLayout {
  const desks = Array.from({ length: agentCount }, (_, index) => createDeskLayout(index));

  return {
    width: PIXEL_OFFICE_WIDTH,
    height: PIXEL_OFFICE_HEIGHT,
    cellSize: PIXEL_OFFICE_CELL_SIZE,
    zones: PIXEL_OFFICE_ZONES,
    loungeWaypoints: PIXEL_OFFICE_LOUNGE_WAYPOINTS,
    desks,
    world: {
      width: PIXEL_OFFICE_WIDTH,
      height: PIXEL_OFFICE_HEIGHT,
      cellSize: PIXEL_OFFICE_CELL_SIZE,
      obstacles: desks.flatMap((desk) => desk.obstacles),
    },
  };
}
