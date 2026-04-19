"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildAgentWorldSnapshot, type AgentWorldModel, type AgentWorldSnapshot } from "@/components/workspace/agent-world-model";
import { createMotionTrack, projectMotionTrack, type MotionTrack } from "@/components/workspace/agent-world-motion";
import { findNearestWalkablePoint, findWorldPath, type WorldPoint } from "@/components/workspace/agent-world-pathfinding";
import type { AgentSharedState, RoomAgentDefinition, RoomAgentId, RoomSession, WorkspaceRuntimeState } from "@/lib/chat/types";

export interface AgentWorldRenderModel extends AgentWorldModel {
  position: WorldPoint;
  isMoving: boolean;
}

export interface AgentWorldRenderSnapshot extends Omit<AgentWorldSnapshot, "agents"> {
  agents: AgentWorldRenderModel[];
}

interface AgentMotionState {
  targetKey: string;
  track: MotionTrack | null;
  settledPosition: WorldPoint;
}

const RESTING_SPEED_UNITS_PER_SECOND = 8;
const WORKING_SPEED_UNITS_PER_SECOND = 16;
const TARGET_EPSILON = 0.2;

function getDistance(left: WorldPoint, right: WorldPoint) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function getAgentTargetKey(agent: AgentWorldModel) {
  return `${agent.targetZone}:${agent.target.x.toFixed(2)}:${agent.target.y.toFixed(2)}`;
}

function getAgentSpeed(agent: AgentWorldModel) {
  return agent.status === "working" ? WORKING_SPEED_UNITS_PER_SECOND : RESTING_SPEED_UNITS_PER_SECOND;
}

function createFallbackPath(start: WorldPoint, target: WorldPoint): WorldPoint[] {
  return [start, target];
}

export function useAgentWorldState(args: {
  agents: RoomAgentDefinition[];
  rooms: RoomSession[];
  agentStates: Record<RoomAgentId, AgentSharedState>;
  runtimeState?: WorkspaceRuntimeState;
  currentRoomId?: string;
}): AgentWorldRenderSnapshot {
  const [now, setNow] = useState(() => Date.now());
  const [animationNow, setAnimationNow] = useState(() => Date.now());
  const [renderAgents, setRenderAgents] = useState<AgentWorldRenderModel[]>([]);
  const motionByAgentRef = useRef<Partial<Record<RoomAgentId, AgentMotionState>>>({});

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  useEffect(() => {
    let animationFrameId = 0;
    const tick = () => {
      setAnimationNow(Date.now());
      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, []);

  const logicalSnapshot = useMemo(
    () =>
      buildAgentWorldSnapshot({
        agents: args.agents,
        rooms: args.rooms,
        agentStates: args.agentStates,
        runtimeState: args.runtimeState,
        currentRoomId: args.currentRoomId,
        now,
      }),
    [args.agentStates, args.agents, args.currentRoomId, args.rooms, args.runtimeState, now],
  );

  useEffect(() => {
    const startedAtMs = Date.now();
    const remainingAgentIds = new Set(Object.keys(motionByAgentRef.current) as RoomAgentId[]);

    for (const agent of logicalSnapshot.agents) {
      remainingAgentIds.delete(agent.agentId);
      const target = { x: agent.target.x, y: agent.target.y };
      const targetKey = getAgentTargetKey(agent);
      const existing = motionByAgentRef.current[agent.agentId];

      if (!existing) {
        motionByAgentRef.current[agent.agentId] = {
          targetKey,
          track: null,
          settledPosition: target,
        };
        continue;
      }

      if (existing.targetKey === targetKey) {
        if (existing.track) {
          const projected = projectMotionTrack(existing.track, startedAtMs);
          if (projected.arrived) {
            existing.track = null;
            existing.settledPosition = target;
          }
        }
        continue;
      }

      const currentPosition = existing.track ? projectMotionTrack(existing.track, startedAtMs).position : existing.settledPosition;
      existing.targetKey = targetKey;

      if (getDistance(currentPosition, target) <= TARGET_EPSILON) {
        existing.track = null;
        existing.settledPosition = target;
        continue;
      }

      const nearestTarget = findNearestWalkablePoint(logicalSnapshot.world, target) ?? target;
      const path = findWorldPath({
        world: logicalSnapshot.world,
        start: currentPosition,
        target: nearestTarget,
      }) ?? createFallbackPath(currentPosition, nearestTarget);

      existing.track = createMotionTrack({
        path,
        speedUnitsPerSecond: getAgentSpeed(agent),
        startedAtMs,
      });
      existing.settledPosition = currentPosition;
    }

    for (const agentId of remainingAgentIds) {
      delete motionByAgentRef.current[agentId];
    }
  }, [logicalSnapshot]);

  useEffect(() => {
    setRenderAgents(
      logicalSnapshot.agents.map((agent) => {
        const motion = motionByAgentRef.current[agent.agentId];
        const target = { x: agent.target.x, y: agent.target.y };
        if (!motion?.track) {
          return {
            ...agent,
            position: motion?.settledPosition ?? target,
            isMoving: false,
          };
        }

        const projected = projectMotionTrack(motion.track, animationNow);
        return {
          ...agent,
          position: projected.position,
          isMoving: !projected.arrived,
        };
      }),
    );
  }, [animationNow, logicalSnapshot]);

  return {
    ...logicalSnapshot,
    agents:
      renderAgents.length === logicalSnapshot.agents.length
        ? renderAgents
        : logicalSnapshot.agents.map((agent) => ({
            ...agent,
            position: { x: agent.target.x, y: agent.target.y },
            isMoving: false,
          })),
  };
}
