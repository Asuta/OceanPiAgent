import { z } from "zod";
import {
  listProjectContextFiles,
  readProjectContextFile,
} from "@/lib/ai/project-context";
import {
  createStructuredOutput,
  projectContextReadArgsSchema,
  type ToolDefinition,
  emptyArgsSchema,
} from "./shared";

export const projectContextTools = {
  project_context_list: {
    name: "project_context_list",
    displayName: "Project Context List",
    description:
      "List local project guidance files that the agent may consult for architecture, workflow, and configuration conventions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    validate: (value: unknown) => emptyArgsSchema.parse(value),
    execute: async () => createStructuredOutput({ entries: await listProjectContextFiles() }),
  } satisfies ToolDefinition<unknown>,
  project_context_read: {
    name: "project_context_read",
    displayName: "Project Context Read",
    description:
      "Read one approved local project context file, such as PROJECT_CONTEXT.md or a docs markdown file, in focused line ranges.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Relative path from project_context_list." },
        fromLine: { type: "number", description: "Optional 1-based starting line number." },
        lineCount: { type: "number", description: "Optional number of lines to read. Defaults to 200." },
      },
      required: ["path"],
    },
    validate: (value: unknown) => projectContextReadArgsSchema.parse(value),
    execute: async (value: unknown) => {
      const args = value as z.infer<typeof projectContextReadArgsSchema>;
      return createStructuredOutput(
        await readProjectContextFile({
          path: args.path,
          fromLine: args.fromLine,
          lineCount: args.lineCount,
        }),
      );
    },
  } satisfies ToolDefinition<unknown>,
};
