"use client";

import { useEffect, useMemo, useState } from "react";
import { buildAgentWorldSnapshot } from "@/components/workspace/agent-world-model";
import type { AgentSharedState, RoomAgentDefinition, RoomAgentId, RoomSession } from "@/lib/chat/types";

export function useAgentWorldState(args: {
  agents: RoomAgentDefinition[];
  rooms: RoomSession[];
  agentStates: Record<RoomAgentId, AgentSharedState>;
  currentRoomId?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  return useMemo(
    () =>
      buildAgentWorldSnapshot({
        agents: args.agents,
        rooms: args.rooms,
        agentStates: args.agentStates,
        currentRoomId: args.currentRoomId,
        now,
      }),
    [args.agentStates, args.agents, args.currentRoomId, args.rooms, now],
  );
}
