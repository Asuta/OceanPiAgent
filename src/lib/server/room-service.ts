import type { MessageImageAttachment, RoomAgentDefinition, RoomAgentId, RoomSession, RoomWorkspaceState } from "@/lib/chat/types";
import {
  createAgentSharedState,
  createRoomSession,
  DEFAULT_AGENT_ID,
  DEFAULT_LOCAL_PARTICIPANT_ID as DEFAULT_LOCAL_PARTICIPANT_KEY,
  sortRoomsByUpdatedAt,
} from "@/lib/chat/workspace-domain";
import {
  addAgentParticipantToRoom,
  addHumanParticipantToRoom,
  applyOutgoingUserMessage,
  getSuggestedRoomTitle,
  moveAgentParticipantInRoom,
  removeParticipantFromRoom,
  resolveRoomMessageSender,
  shouldAutoTitleRoom,
  toggleAgentParticipantInRoom,
} from "@/lib/chat/room-actions";
import { listAgentDefinitions } from "@/lib/server/agent-registry";
import { enqueueRoomScheduler } from "@/lib/server/room-scheduler";
import { loadWorkspaceEnvelope, mutateWorkspace, type WorkspaceEnvelope } from "@/lib/server/workspace-store";
import { createUuid } from "@/lib/utils/uuid";

const DEFAULT_LOCAL_PARTICIPANT_NAME = "You";

type RoomCommandResult = {
  envelope: WorkspaceEnvelope;
  room?: RoomSession | null;
};

export type AppendedRoomMessageResult = {
  envelope: WorkspaceEnvelope;
  room: RoomSession;
  userMessage: RoomSession["roomMessages"][number];
};

type RoomServiceDependencies = {
  loadWorkspaceEnvelope: typeof loadWorkspaceEnvelope;
  mutateWorkspace: typeof mutateWorkspace;
  listAgentDefinitions: () => Promise<RoomAgentDefinition[]>;
  enqueueRoomScheduler: typeof enqueueRoomScheduler;
};

export type RoomCommandInput =
  | { type: "create_room"; agentId?: RoomAgentId }
  | { type: "rename_room"; roomId: string; title: string }
  | { type: "archive_room"; roomId: string }
  | { type: "restore_room"; roomId: string }
  | { type: "delete_room"; roomId: string }
  | { type: "clear_room"; roomId: string }
  | { type: "add_human_participant"; roomId: string; name: string }
  | { type: "add_agent_participant"; roomId: string; agentId: RoomAgentId }
  | { type: "remove_participant"; roomId: string; participantId: string }
  | { type: "toggle_agent_participant"; roomId: string; participantId: string }
  | { type: "move_agent_participant"; roomId: string; participantId: string; direction: -1 | 1 }
  | { type: "send_message"; roomId: string; content: string; attachments?: MessageImageAttachment[]; senderId?: string };

function getNextRoomIndex(rooms: RoomSession[]): number {
  return rooms.length + 1;
}

function requireRoom(workspace: RoomWorkspaceState, roomId: string): RoomSession {
  const room = workspace.rooms.find((entry) => entry.id === roomId);
  if (!room) {
    throw new Error(`Room ${roomId} does not exist.`);
  }
  return room;
}

function assertRoomNotRunning(room: RoomSession): void {
  if (room.scheduler.status === "running") {
    throw new Error("Room is currently running.");
  }
}

function ensureAgentStates(
  workspace: RoomWorkspaceState,
  agentIds: RoomAgentId[],
): Record<RoomAgentId, RoomWorkspaceState["agentStates"][RoomAgentId]> {
  let changed = false;
  const nextAgentStates = { ...workspace.agentStates };

  for (const agentId of agentIds) {
    if (!nextAgentStates[agentId]) {
      nextAgentStates[agentId] = createAgentSharedState();
      changed = true;
    }
  }

  return changed ? nextAgentStates : workspace.agentStates;
}

async function applyMutation(
  mutator: (workspace: RoomWorkspaceState, agentDefinitions: RoomAgentDefinition[]) => RoomWorkspaceState,
  deps: RoomServiceDependencies,
): Promise<WorkspaceEnvelope> {
  const agentDefinitions = await deps.listAgentDefinitions();
  return deps.mutateWorkspace((workspace) => mutator(workspace, agentDefinitions));
}

export async function appendUserRoomMessage(
  args: {
    roomId: string;
    content: string;
    attachments?: MessageImageAttachment[];
    senderId?: string;
  },
  overrides: Partial<RoomServiceDependencies> = {},
): Promise<AppendedRoomMessageResult> {
  const deps: RoomServiceDependencies = {
    loadWorkspaceEnvelope: overrides.loadWorkspaceEnvelope ?? loadWorkspaceEnvelope,
    mutateWorkspace: overrides.mutateWorkspace ?? mutateWorkspace,
    listAgentDefinitions: overrides.listAgentDefinitions ?? listAgentDefinitions,
    enqueueRoomScheduler: overrides.enqueueRoomScheduler ?? enqueueRoomScheduler,
  };

  const normalizedContent = args.content.trim();
  if (!normalizedContent && (args.attachments?.length ?? 0) === 0) {
    throw new Error("Message content or at least one attachment is required.");
  }

  const envelope = await applyMutation((workspace) => {
    const room = requireRoom(workspace, args.roomId);
    const sender = resolveRoomMessageSender({
      room,
      senderId: args.senderId,
      defaultLocalParticipantId: DEFAULT_LOCAL_PARTICIPANT_KEY,
      defaultLocalParticipantName: DEFAULT_LOCAL_PARTICIPANT_NAME,
    });
    if (!sender) {
      throw new Error("Could not resolve a room participant to send this message.");
    }

    const nextTitle = shouldAutoTitleRoom(room) ? getSuggestedRoomTitle(normalizedContent) || room.title : room.title;
    return {
      ...workspace,
      rooms: sortRoomsByUpdatedAt(
        workspace.rooms.map((entry) =>
          entry.id === args.roomId
            ? applyOutgoingUserMessage({
                room: entry,
                content: normalizedContent,
                attachments: args.attachments ?? [],
                sender,
                nextTitle,
              })
            : entry,
        ),
      ),
    };
  }, deps);

  const room = envelope.state.rooms.find((entry) => entry.id === args.roomId);
  const userMessage = room?.roomMessages[room.roomMessages.length - 1] ?? null;
  if (!room || !userMessage) {
    throw new Error(`Room ${args.roomId} did not return the appended user message.`);
  }

  return {
    envelope,
    room,
    userMessage,
  };
}

export async function runRoomCommand(
  input: RoomCommandInput,
  overrides: Partial<RoomServiceDependencies> = {},
): Promise<RoomCommandResult> {
  const deps: RoomServiceDependencies = {
    loadWorkspaceEnvelope: overrides.loadWorkspaceEnvelope ?? loadWorkspaceEnvelope,
    mutateWorkspace: overrides.mutateWorkspace ?? mutateWorkspace,
    listAgentDefinitions: overrides.listAgentDefinitions ?? listAgentDefinitions,
    enqueueRoomScheduler: overrides.enqueueRoomScheduler ?? enqueueRoomScheduler,
  };

  if (input.type === "create_room") {
    const envelope = await applyMutation((workspace, agentDefinitions) => {
      const resolvedAgentId = input.agentId ?? DEFAULT_AGENT_ID;
      const room = createRoomSession(getNextRoomIndex(workspace.rooms), resolvedAgentId, agentDefinitions);
      return {
        ...workspace,
        rooms: sortRoomsByUpdatedAt([room, ...workspace.rooms]),
        agentStates: ensureAgentStates(workspace, [resolvedAgentId]),
      };
    }, deps);
    return {
      envelope,
      room: envelope.state.rooms[0] ?? null,
    };
  }

  if (input.type === "send_message") {
    await appendUserRoomMessage({
      roomId: input.roomId,
      content: input.content,
      attachments: input.attachments,
      senderId: input.senderId,
    }, deps);

    await deps.enqueueRoomScheduler(input.roomId);
    const envelope = await deps.loadWorkspaceEnvelope();
    return {
      envelope,
      room: envelope.state.rooms.find((entry) => entry.id === input.roomId) ?? null,
    };
  }

  const workspaceEnvelope = await deps.loadWorkspaceEnvelope();
  const room = requireRoom(workspaceEnvelope.state, input.roomId);
  assertRoomNotRunning(room);

  if (input.type === "rename_room") {
    const title = input.title.trim();
    if (!title) {
      throw new Error("Room title cannot be empty.");
    }
    const envelope = await applyMutation((workspace) => ({
      ...workspace,
      rooms: sortRoomsByUpdatedAt(
        workspace.rooms.map((entry) =>
          entry.id === input.roomId
            ? {
                ...entry,
                title,
                updatedAt: new Date().toISOString(),
              }
            : entry,
        ),
      ),
    }), deps);
    return { envelope, room: envelope.state.rooms.find((entry) => entry.id === input.roomId) ?? null };
  }

  if (input.type === "archive_room") {
    const envelope = await applyMutation((workspace) => ({
      ...workspace,
      rooms: sortRoomsByUpdatedAt(
        workspace.rooms.map((entry) =>
          entry.id === input.roomId
            ? {
                ...entry,
                archivedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }
            : entry,
        ),
      ),
    }), deps);
    return { envelope, room: envelope.state.rooms.find((entry) => entry.id === input.roomId) ?? null };
  }

  if (input.type === "restore_room") {
    const envelope = await applyMutation((workspace) => ({
      ...workspace,
      rooms: sortRoomsByUpdatedAt(
        workspace.rooms.map((entry) =>
          entry.id === input.roomId
            ? {
                ...entry,
                archivedAt: null,
                updatedAt: new Date().toISOString(),
              }
            : entry,
        ),
      ),
    }), deps);
    return { envelope, room: envelope.state.rooms.find((entry) => entry.id === input.roomId) ?? null };
  }

  if (input.type === "delete_room") {
    const envelope = await applyMutation((workspace) => ({
      ...workspace,
      rooms: sortRoomsByUpdatedAt(workspace.rooms.filter((entry) => entry.id !== input.roomId)),
    }), deps);
    return { envelope, room: null };
  }

  if (input.type === "clear_room") {
    const envelope = await applyMutation((workspace) => ({
      ...workspace,
      rooms: sortRoomsByUpdatedAt(
        workspace.rooms.map((entry) =>
          entry.id === input.roomId
            ? {
                ...entry,
                roomMessages: [],
                receiptRevision: 0,
                scheduler: {
                  ...entry.scheduler,
                  status: "idle",
                  activeParticipantId: null,
                  roundCount: 0,
                  agentCursorByParticipantId: {},
                  agentReceiptRevisionByParticipantId: {},
                },
                error: "",
                updatedAt: new Date().toISOString(),
              }
            : entry,
        ),
      ),
    }), deps);
    return { envelope, room: envelope.state.rooms.find((entry) => entry.id === input.roomId) ?? null };
  }

  if (input.type === "add_human_participant") {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Participant name cannot be empty.");
    }
    const envelope = await applyMutation((workspace) => ({
      ...workspace,
      rooms: sortRoomsByUpdatedAt(
        workspace.rooms.map((entry) =>
          entry.id === input.roomId
            ? addHumanParticipantToRoom({
                room: entry,
                name,
                 createParticipantId: (prefix) => `${prefix}-${createUuid().slice(0, 8)}`,
              })
            : entry,
        ),
      ),
    }), deps);
    return { envelope, room: envelope.state.rooms.find((entry) => entry.id === input.roomId) ?? null };
  }

  if (input.type === "add_agent_participant") {
    const envelope = await applyMutation((workspace, agentDefinitions) => ({
      ...workspace,
      rooms: sortRoomsByUpdatedAt(
        workspace.rooms.map((entry) =>
          entry.id === input.roomId ? addAgentParticipantToRoom({ room: entry, agentId: input.agentId, agentDefinitions }) : entry,
        ),
      ),
      agentStates: ensureAgentStates(workspace, [input.agentId]),
    }), deps);
    return { envelope, room: envelope.state.rooms.find((entry) => entry.id === input.roomId) ?? null };
  }

  if (input.type === "remove_participant") {
    const envelope = await applyMutation((workspace) => ({
      ...workspace,
      rooms: sortRoomsByUpdatedAt(
        workspace.rooms.map((entry) =>
          entry.id === input.roomId ? removeParticipantFromRoom({ room: entry, participantId: input.participantId }) : entry,
        ),
      ),
    }), deps);
    return { envelope, room: envelope.state.rooms.find((entry) => entry.id === input.roomId) ?? null };
  }

  if (input.type === "toggle_agent_participant") {
    const envelope = await applyMutation((workspace) => ({
      ...workspace,
      rooms: sortRoomsByUpdatedAt(
        workspace.rooms.map((entry) =>
          entry.id === input.roomId ? toggleAgentParticipantInRoom({ room: entry, participantId: input.participantId }) : entry,
        ),
      ),
    }), deps);
    return { envelope, room: envelope.state.rooms.find((entry) => entry.id === input.roomId) ?? null };
  }

  const envelope = await applyMutation((workspace) => ({
    ...workspace,
    rooms: sortRoomsByUpdatedAt(
      workspace.rooms.map((entry) =>
        entry.id === input.roomId
          ? moveAgentParticipantInRoom({ room: entry, participantId: input.participantId, direction: input.direction })
          : entry,
      ),
    ),
  }), deps);
  return { envelope, room: envelope.state.rooms.find((entry) => entry.id === input.roomId) ?? null };
}
