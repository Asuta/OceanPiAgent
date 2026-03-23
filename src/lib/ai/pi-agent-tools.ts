import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum, Type, type TSchema } from "@mariozechner/pi-ai";
import { runAfterToolCallHooks, runBeforeToolCallHooks } from "./runtime-hooks";
import { executeTool } from "./tools";
import type { RoomToolContext, ToolExecution, ToolScope } from "@/lib/chat/types";

const ROOM_MESSAGE_KIND_ENUM = StringEnum(["answer", "progress", "warning", "error", "clarification"]);
const ROOM_MESSAGE_STATUS_ENUM = StringEnum(["pending", "streaming", "completed", "failed"]);
const CUSTOM_COMMAND_ENUM = StringEnum(["list_commands", "project_profile", "current_time", "web_fetch"]);

export interface PiToolResultDetails {
  toolEvent: ToolExecution;
}

function createPiTool<TParameters extends TSchema>(definition: {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  scope: ToolScope;
  roomToolContext?: RoomToolContext;
}): AgentTool<TParameters, PiToolResultDetails> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    async execute(toolCallId, params, signal) {
      await runBeforeToolCallHooks({
        agentId: definition.roomToolContext?.currentAgentId,
        toolName: definition.name,
        params,
        toolScope: definition.scope,
        toolContext: definition.roomToolContext,
      });

      const { output, event } = await executeTool(
        definition.name,
        params,
        definition.scope,
        signal,
        definition.roomToolContext
          ? {
              room: definition.roomToolContext,
            }
          : undefined,
      );

      return {
        ...(await (async () => {
          const toolEvent = {
            ...event,
            id: toolCallId,
          };
          await runAfterToolCallHooks({
            agentId: definition.roomToolContext?.currentAgentId,
            toolName: definition.name,
            params,
            toolScope: definition.scope,
            toolContext: definition.roomToolContext,
            toolEvent,
          });
          return {
            content: [{ type: "text", text: output }],
            details: {
              toolEvent,
            },
          };
        })()),
      };
    },
  };
}

function buildBaseTools(scope: ToolScope, roomToolContext?: RoomToolContext) {
  return [
    createPiTool({
      name: "web_fetch",
      label: "Web Fetch",
      description: "Fetch a public webpage when you need live facts, then return readable text for synthesis.",
      parameters: Type.Object({
        url: Type.String({ description: "A full http or https URL." }),
        focus: Type.Optional(Type.String({ description: "Optional note about what to focus on." })),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "custom_command",
      label: "Custom Command",
      description: "Run a registered workspace command for discovery, project context, current time, or delegated web fetches.",
      parameters: Type.Object({
        command: CUSTOM_COMMAND_ENUM,
        url: Type.Optional(Type.String({ description: "Required when using the web_fetch command." })),
        timezone: Type.Optional(Type.String({ description: "Optional IANA timezone." })),
        topic: Type.Optional(Type.String({ description: "Optional extra focus or question." })),
      }),
      scope,
      roomToolContext,
    }),
  ];
}

function buildRoomTools(scope: ToolScope, roomToolContext?: RoomToolContext) {
  return [
    createPiTool({
      name: "send_message_to_room",
      label: "Send Message To Room",
      description: "Deliver user-visible content into any attached room, whether you are sending in the current room or relaying into another room.",
      parameters: Type.Object({
        roomId: Type.String({ description: "Target attached room id." }),
        content: Type.String({ description: "Exact user-visible content to send." }),
        kind: Type.Optional(ROOM_MESSAGE_KIND_ENUM),
        status: Type.Optional(ROOM_MESSAGE_STATUS_ENUM),
        final: Type.Optional(Type.Boolean({ description: "Whether this is the final visible message for this turn." })),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "read_no_reply",
      label: "Read No Reply",
      description: "Mark a participant message as intentionally seen without creating any visible room message.",
      parameters: Type.Object({
        roomId: Type.String({ description: "Attached room id." }),
        messageId: Type.String({ description: "Participant message id to mark as seen." }),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "list_attached_rooms",
      label: "List Attached Rooms",
      description: "Return the authoritative list of rooms this agent can currently route messages into.",
      parameters: Type.Object({}),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "list_known_agents",
      label: "List Known Agents",
      description: "Inspect the known agent phonebook before deciding who should join or receive work.",
      parameters: Type.Object({}),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "create_room",
      label: "Create Room",
      description: "Create a new attached room and optionally seed it with specific agents.",
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: "Optional room title." })),
        agentIds: Type.Optional(Type.Array(Type.String({ description: "Agent id to include." }))),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "add_agents_to_room",
      label: "Add Agents To Room",
      description: "Invite one or more known agents into an attached room that you own.",
      parameters: Type.Object({
        roomId: Type.String({ description: "Attached room id." }),
        agentIds: Type.Array(Type.String({ description: "Agent id to add." })),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "leave_room",
      label: "Leave Room",
      description: "Remove the current agent from an attached room when it should stop participating.",
      parameters: Type.Object({
        roomId: Type.String({ description: "Attached room id." }),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "remove_room_participant",
      label: "Remove Room Participant",
      description: "Kick a participant out of an attached room that you own.",
      parameters: Type.Object({
        roomId: Type.String({ description: "Attached room id." }),
        participantId: Type.String({ description: "Participant id to remove." }),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "get_room_history",
      label: "Get Room History",
      description: "Inspect recent visible history for an attached room before sending or relaying.",
      parameters: Type.Object({
        roomId: Type.String({ description: "Attached room id." }),
        limit: Type.Optional(Type.Integer({ description: "How many recent messages to return." })),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "memory_search",
      label: "Memory Search",
      description: "Search persisted agent memory for prior room decisions, summaries, and tool outcomes before answering cross-room or long-running questions.",
      parameters: Type.Object({
        query: Type.String({ description: "What prior context or fact you need to retrieve." }),
        maxResults: Type.Optional(Type.Integer({ description: "Optional maximum number of memory hits." })),
        minScore: Type.Optional(Type.Number({ description: "Optional minimum score threshold." })),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "memory_get",
      label: "Memory Get",
      description: "Read a specific persisted memory file slice after memory_search identifies the relevant path and lines.",
      parameters: Type.Object({
        path: Type.String({ description: "The memory file path returned by memory_search." }),
        from: Type.Optional(Type.Integer({ description: "Optional starting line number." })),
        lines: Type.Optional(Type.Integer({ description: "Optional number of lines to read." })),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "workspace_list",
      label: "Workspace List",
      description: "List files and directories in your dedicated workspace for this agent.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Optional relative directory path inside the workspace." })),
        recursive: Type.Optional(Type.Boolean({ description: "Whether to include nested entries recursively." })),
        limit: Type.Optional(Type.Integer({ description: "Optional maximum number of returned entries." })),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "workspace_read",
      label: "Workspace Read",
      description: "Read a text file from your dedicated workspace for this agent.",
      parameters: Type.Object({
        path: Type.String({ description: "Relative file path inside the workspace." }),
        fromLine: Type.Optional(Type.Integer({ description: "Optional 1-based starting line number." })),
        lineCount: Type.Optional(Type.Integer({ description: "Optional number of lines to read." })),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "workspace_write",
      label: "Workspace Write",
      description: "Create or overwrite a text file in your dedicated workspace for this agent.",
      parameters: Type.Object({
        path: Type.String({ description: "Relative file path inside the workspace." }),
        content: Type.String({ description: "Full file content to write." }),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "workspace_delete",
      label: "Workspace Delete",
      description: "Delete a file or directory in your dedicated workspace for this agent. Use recursive=true for non-empty directories.",
      parameters: Type.Object({
        path: Type.String({ description: "Relative path inside the workspace." }),
        recursive: Type.Optional(Type.Boolean({ description: "Whether to delete directories recursively." })),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "workspace_append",
      label: "Workspace Append",
      description: "Append text to the end of a file in your dedicated workspace for this agent, creating the file if needed.",
      parameters: Type.Object({
        path: Type.String({ description: "Relative file path inside the workspace." }),
        content: Type.String({ description: "Text content to append." }),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "workspace_move",
      label: "Workspace Move",
      description: "Rename or move a file or directory within your dedicated workspace for this agent.",
      parameters: Type.Object({
        fromPath: Type.String({ description: "Existing relative source path inside the workspace." }),
        toPath: Type.String({ description: "Relative destination path inside the workspace." }),
      }),
      scope,
      roomToolContext,
    }),
    createPiTool({
      name: "workspace_mkdir",
      label: "Workspace Mkdir",
      description: "Create a directory in your dedicated workspace for this agent, with recursive parent creation by default.",
      parameters: Type.Object({
        path: Type.String({ description: "Relative directory path inside the workspace." }),
        recursive: Type.Optional(Type.Boolean({ description: "Whether to create missing parent directories automatically." })),
      }),
      scope,
      roomToolContext,
    }),
  ];
}

export function getPiAgentTools(scope: ToolScope = "default", roomToolContext?: RoomToolContext): AgentTool<TSchema, PiToolResultDetails>[] {
  const tools = buildBaseTools(scope, roomToolContext);
  if (scope !== "room") {
    return tools as unknown as AgentTool<TSchema, PiToolResultDetails>[];
  }

  return [...tools, ...buildRoomTools(scope, roomToolContext)] as unknown as AgentTool<TSchema, PiToolResultDetails>[];
}
