import { z } from "zod";
import { bashTool } from "./bash-tool";
import { executeCustomCommand } from "./custom-commands";
import { fetchWebPage } from "./web-fetch";
import { customCommandArgsSchema, webFetchArgsSchema, type ToolDefinition } from "./shared";

export const baseTools = {
  bash: bashTool,
  web_fetch: {
    name: "web_fetch",
    displayName: "Web Fetch",
    description:
      "Fetch a public webpage, remove noisy markup, and return a readable text excerpt. Use this when the user asks about current online content.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description: "The full http or https URL to fetch.",
        },
        focus: {
          type: "string",
          description: "Optional note for what information matters most on the page.",
        },
      },
      required: ["url"],
    },
    validate: (value: unknown) => webFetchArgsSchema.parse(value),
    execute: async (value: unknown, signal?: AbortSignal) => {
      const args = value as z.infer<typeof webFetchArgsSchema>;
      return fetchWebPage(args, signal);
    },
  } satisfies ToolDefinition<unknown>,
  custom_command: {
    name: "custom_command",
    displayName: "Custom Command",
    description:
      "Run one of the registered commands: list_commands, project_profile, current_time, or web_fetch. The web_fetch command also accepts url and optional topic.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          enum: ["list_commands", "project_profile", "current_time", "web_fetch"],
          description: "Which registered command to run.",
        },
        url: {
          type: "string",
          description: "Required when command is web_fetch.",
        },
        timezone: {
          type: "string",
          description: "Optional IANA timezone when command is current_time.",
        },
        topic: {
          type: "string",
          description: "Optional extra focus or question for the chosen command.",
        },
      },
      required: ["command"],
    },
    validate: (value: unknown) => customCommandArgsSchema.parse(value),
    execute: async (value: unknown, signal?: AbortSignal) => {
      const args = value as z.infer<typeof customCommandArgsSchema>;
      return executeCustomCommand(args, signal);
    },
  } satisfies ToolDefinition<unknown>,
};
