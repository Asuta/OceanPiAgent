import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { RoomAgentDefinition, RoomAgentId, RoomSession } from "@/lib/chat/types";
import { getPrimaryRoomAgentId } from "@/lib/chat/workspace-domain";

type MutableRef<T> = {
  current: T;
};

export function useRoomCommands(args: {
  defaultAgentId: RoomAgentId;
  defaultLocalParticipantId: string;
  agentsRef: MutableRef<RoomAgentDefinition[]>;
  runRoomCommandRequest: (
    payload: Record<string, unknown>,
    options?: {
      pendingRoomId?: string;
    },
  ) => Promise<{ rooms: RoomSession[] } | null | undefined>;
  clearDraftForRoom: (roomId: string) => void;
  setActiveRoomId: (roomId: string) => void;
  setSelectedConsoleAgentId: (agentId: RoomAgentId | null) => void;
  setSelectedSenderByRoomId: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const {
    defaultAgentId,
    defaultLocalParticipantId,
    agentsRef,
    runRoomCommandRequest,
    clearDraftForRoom,
    setActiveRoomId,
    setSelectedConsoleAgentId,
    setSelectedSenderByRoomId,
  } = args;

  const createRoom = useCallback(
    async (agentId: RoomAgentId = defaultAgentId) => {
      const resolvedAgentId = agentsRef.current.some((agent) => agent.id === agentId)
        ? agentId
        : (agentsRef.current[0]?.id ?? defaultAgentId);
      const snapshot = await runRoomCommandRequest({
        type: "create_room",
        agentId: resolvedAgentId,
      });
      const nextRoom = snapshot?.rooms[0] ?? null;
      if (nextRoom) {
        setActiveRoomId(nextRoom.id);
        setSelectedConsoleAgentId(getPrimaryRoomAgentId(nextRoom));
        setSelectedSenderByRoomId((current) => ({
          ...current,
          [nextRoom.id]: defaultLocalParticipantId,
        }));
      }
      return nextRoom;
    },
    [agentsRef, defaultAgentId, defaultLocalParticipantId, runRoomCommandRequest, setActiveRoomId, setSelectedConsoleAgentId, setSelectedSenderByRoomId],
  );

  const renameRoom = useCallback(
    async (roomId: string, title: string) => {
      const normalizedTitle = title.trim();
      if (!normalizedTitle) {
        return;
      }

      await runRoomCommandRequest(
        {
          type: "rename_room",
          roomId,
          title: normalizedTitle,
        },
        { pendingRoomId: roomId },
      );
    },
    [runRoomCommandRequest],
  );

  const archiveRoom = useCallback(
    async (roomId: string) => {
      await runRoomCommandRequest(
        {
          type: "archive_room",
          roomId,
        },
        { pendingRoomId: roomId },
      );
      clearDraftForRoom(roomId);
    },
    [clearDraftForRoom, runRoomCommandRequest],
  );

  const restoreRoom = useCallback(
    async (roomId: string) => {
      await runRoomCommandRequest(
        {
          type: "restore_room",
          roomId,
        },
        { pendingRoomId: roomId },
      );
      setActiveRoomId(roomId);
    },
    [runRoomCommandRequest, setActiveRoomId],
  );

  const deleteRoom = useCallback(
    async (roomId: string) => {
      await runRoomCommandRequest(
        {
          type: "delete_room",
          roomId,
        },
        { pendingRoomId: roomId },
      );
      clearDraftForRoom(roomId);
      setSelectedSenderByRoomId((current) => {
        const nextState = { ...current };
        delete nextState[roomId];
        return nextState;
      });
    },
    [clearDraftForRoom, runRoomCommandRequest, setSelectedSenderByRoomId],
  );

  const clearRoom = useCallback(
    async (roomId: string) => {
      await runRoomCommandRequest(
        {
          type: "clear_room",
          roomId,
        },
        { pendingRoomId: roomId },
      );
      clearDraftForRoom(roomId);
    },
    [clearDraftForRoom, runRoomCommandRequest],
  );

  const clearRoomLogs = useCallback(
    async (roomId: string) => {
      await runRoomCommandRequest(
        {
          type: "clear_room_logs",
          roomId,
        },
        { pendingRoomId: roomId },
      );
      clearDraftForRoom(roomId);
    },
    [clearDraftForRoom, runRoomCommandRequest],
  );

  const addHumanParticipant = useCallback(
    async (roomId: string, name: string) => {
      const normalizedName = name.trim();
      if (!normalizedName) {
        return;
      }

      await runRoomCommandRequest(
        {
          type: "add_human_participant",
          roomId,
          name: normalizedName,
        },
        { pendingRoomId: roomId },
      );
    },
    [runRoomCommandRequest],
  );

  const addAgentParticipant = useCallback(
    async (roomId: string, agentId: RoomAgentId) => {
      await runRoomCommandRequest(
        {
          type: "add_agent_participant",
          roomId,
          agentId,
        },
        { pendingRoomId: roomId },
      );
    },
    [runRoomCommandRequest],
  );

  const removeParticipant = useCallback(
    async (roomId: string, participantId: string) => {
      await runRoomCommandRequest(
        {
          type: "remove_participant",
          roomId,
          participantId,
        },
        { pendingRoomId: roomId },
      );
    },
    [runRoomCommandRequest],
  );

  const toggleAgentParticipant = useCallback(
    async (roomId: string, participantId: string) => {
      await runRoomCommandRequest(
        {
          type: "toggle_agent_participant",
          roomId,
          participantId,
        },
        { pendingRoomId: roomId },
      );
    },
    [runRoomCommandRequest],
  );

  const moveAgentParticipant = useCallback(
    async (roomId: string, participantId: string, direction: -1 | 1) => {
      await runRoomCommandRequest(
        {
          type: "move_agent_participant",
          roomId,
          participantId,
          direction,
        },
        { pendingRoomId: roomId },
      );
    },
    [runRoomCommandRequest],
  );

  return {
    createRoom,
    renameRoom,
    archiveRoom,
    restoreRoom,
    deleteRoom,
    clearRoom,
    clearRoomLogs,
    addHumanParticipant,
    addAgentParticipant,
    removeParticipant,
    toggleAgentParticipant,
    moveAgentParticipant,
  };
}
