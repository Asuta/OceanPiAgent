export const PROMPT_ROOM_TOOL_NAMES = [
  "send_message_to_room",
  "read_no_reply",
  "list_attached_rooms",
  "list_known_agents",
  "create_room",
  "add_agents_to_room",
  "leave_room",
  "remove_room_participant",
  "get_room_history",
] as const;

export type PromptRoomToolName = (typeof PROMPT_ROOM_TOOL_NAMES)[number];
export type RoomToolTransportMode = "native" | "prompt" | "disabled";

const PROMPT_ROOM_TOOL_NAME_SET = new Set<string>(PROMPT_ROOM_TOOL_NAMES);

function readToolName(candidate: { name?: unknown; function?: { name?: unknown } }): string | null {
  if (typeof candidate.name === "string") {
    return candidate.name;
  }

  if (candidate.function && typeof candidate.function.name === "string") {
    return candidate.function.name;
  }

  return null;
}

export function isPromptRoomToolName(value: unknown): value is PromptRoomToolName {
  return typeof value === "string" && PROMPT_ROOM_TOOL_NAME_SET.has(value);
}

export function disablesAllProviderTools(mode?: RoomToolTransportMode | null): boolean {
  return mode === "disabled";
}

export function stripsPromptRoomToolsFromNativeSchema<T>(schema: T): T {
  if (!Array.isArray(schema)) {
    return schema;
  }

  return schema.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return true;
    }

    const toolName = readToolName(entry as { name?: unknown; function?: { name?: unknown } });
    return !toolName || !isPromptRoomToolName(toolName);
  }) as T;
}
