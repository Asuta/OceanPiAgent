import { CUSTOM_COMMANDS } from "@/lib/chat/catalog";
import { truncateText } from "@/lib/shared/text";
import { fetchWebPage } from "./web-fetch";

export type RegisteredCommandName =
  | "list_commands"
  | "project_profile"
  | "current_time"
  | "web_fetch";

export const CUSTOM_COMMAND_NAME_TUPLE = [
  "list_commands",
  "project_profile",
  "current_time",
  "web_fetch",
] as const;

export interface CustomCommandArgs {
  command: RegisteredCommandName;
  url?: string;
  timezone?: string;
  topic?: string;
}

export const CUSTOM_COMMAND_NAMES = [...CUSTOM_COMMAND_NAME_TUPLE];

export async function executeCustomCommand(args: CustomCommandArgs, signal?: AbortSignal): Promise<string> {
  switch (args.command) {
    case "list_commands":
      return CUSTOM_COMMANDS.map((item) => `- ${item.name}: ${item.summary}`).join("\n");

    case "project_profile": {
      const topicLine = args.topic?.trim()
        ? `Requested focus: ${truncateText(args.topic.trim(), 160)}\n`
        : "";

      return [
        "Project: OceanKing",
        "Stack: Next.js App Router + React + TypeScript + Node.js",
        "Current scope: chat UI, OpenAI-compatible backend, switchable Chat Completions / Responses API mode, web_fetch, and a custom command dispatcher.",
        "Storage: no database yet; the browser keeps the chat transcript in localStorage.",
        "Extension path: add more custom commands in src/lib/ai/tools/custom-commands.ts and register more direct tools in src/lib/ai/tools/index.ts.",
        topicLine,
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "current_time": {
      const formatter = new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: args.timezone?.trim() || undefined,
      });

      return `Current server time: ${formatter.format(new Date())}`;
    }

    case "web_fetch": {
      if (!args.url?.trim()) {
        throw new Error("The web_fetch command requires a valid url.");
      }

      return fetchWebPage({ url: args.url.trim(), focus: args.topic }, signal);
    }

    default:
      throw new Error("Unknown custom command.");
  }
}
