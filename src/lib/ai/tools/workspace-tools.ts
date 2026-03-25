import { z } from "zod";
import {
  appendAgentWorkspaceFile,
  appendSharedWorkspaceFile,
  deleteAgentWorkspaceEntry,
  deleteSharedWorkspaceEntry,
  listAgentWorkspace,
  listSharedWorkspace,
  mkdirAgentWorkspace,
  mkdirSharedWorkspace,
  moveAgentWorkspaceEntry,
  moveSharedWorkspaceEntry,
  readAgentWorkspaceFile,
  readSharedWorkspaceFile,
  writeAgentWorkspaceFile,
  writeSharedWorkspaceFile,
} from "@/lib/server/agent-workspace-store";
import {
  createStructuredOutput,
  getCurrentAgentId,
  workspaceAppendArgsSchema,
  workspaceDeleteArgsSchema,
  workspaceListArgsSchema,
  workspaceMkdirArgsSchema,
  workspaceMoveArgsSchema,
  workspaceReadArgsSchema,
  workspaceWriteArgsSchema,
  type ToolDefinition,
} from "./shared";

export const workspaceTools = {
  workspace_list: {
    name: "workspace_list",
    displayName: "Workspace List",
    description:
      "List files and directories inside this agent's dedicated workspace. Use relative paths by default. Recursive listing is optional and stays inside the current agent workspace unless the operator explicitly enables outside access on the server.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Optional relative directory path inside the current agent workspace. Omit to list the workspace root." },
        recursive: { type: "boolean", description: "Whether to include nested files and directories recursively." },
        limit: { type: "number", description: "Maximum number of entries to return. Defaults to 200." },
      },
    },
    validate: (value: unknown) => workspaceListArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof workspaceListArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await listAgentWorkspace({ agentId, path: args.path, recursive: args.recursive, limit: args.limit });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  workspace_read: {
    name: "workspace_read",
    displayName: "Workspace Read",
    description:
      "Read a text file from this agent's dedicated workspace using a relative path. Use fromLine and lineCount to inspect large files in focused slices.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Relative file path inside the current agent workspace." },
        fromLine: { type: "number", description: "Optional 1-based starting line number." },
        lineCount: { type: "number", description: "Optional number of lines to read. Defaults to 200." },
      },
      required: ["path"],
    },
    validate: (value: unknown) => workspaceReadArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof workspaceReadArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await readAgentWorkspaceFile({
        agentId,
        path: args.path,
        fromLine: args.fromLine,
        lineCount: args.lineCount,
      });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  workspace_write: {
    name: "workspace_write",
    displayName: "Workspace Write",
    description:
      "Create or overwrite a text file inside this agent's dedicated workspace. Parent directories are created automatically.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Relative file path inside the current agent workspace." },
        content: { type: "string", description: "Full text content to write into the target file." },
      },
      required: ["path", "content"],
    },
    validate: (value: unknown) => workspaceWriteArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof workspaceWriteArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await writeAgentWorkspaceFile({ agentId, path: args.path, content: args.content });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  workspace_delete: {
    name: "workspace_delete",
    displayName: "Workspace Delete",
    description:
      "Delete a file or directory inside this agent's dedicated workspace. Set recursive to true when deleting a non-empty directory. The workspace root itself cannot be deleted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Relative path to the file or directory inside the current agent workspace." },
        recursive: { type: "boolean", description: "Whether to delete directories recursively." },
      },
      required: ["path"],
    },
    validate: (value: unknown) => workspaceDeleteArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof workspaceDeleteArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await deleteAgentWorkspaceEntry({ agentId, path: args.path, recursive: args.recursive });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  workspace_append: {
    name: "workspace_append",
    displayName: "Workspace Append",
    description:
      "Append text to the end of a file inside this agent's dedicated workspace. Create the file automatically if it does not exist yet.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Relative file path inside the current agent workspace." },
        content: { type: "string", description: "Text content to append to the target file." },
      },
      required: ["path", "content"],
    },
    validate: (value: unknown) => workspaceAppendArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof workspaceAppendArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await appendAgentWorkspaceFile({ agentId, path: args.path, content: args.content });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  workspace_move: {
    name: "workspace_move",
    displayName: "Workspace Move",
    description:
      "Rename or move a file or directory inside this agent's dedicated workspace. The destination must not already exist.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fromPath: { type: "string", description: "Existing relative source path inside the current agent workspace." },
        toPath: { type: "string", description: "Relative destination path inside the current agent workspace." },
      },
      required: ["fromPath", "toPath"],
    },
    validate: (value: unknown) => workspaceMoveArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof workspaceMoveArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await moveAgentWorkspaceEntry({ agentId, fromPath: args.fromPath, toPath: args.toPath });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  workspace_mkdir: {
    name: "workspace_mkdir",
    displayName: "Workspace Mkdir",
    description: "Create a directory inside this agent's dedicated workspace. Recursive creation is enabled by default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Relative directory path inside the current agent workspace." },
        recursive: { type: "boolean", description: "Whether to create missing parent directories automatically." },
      },
      required: ["path"],
    },
    validate: (value: unknown) => workspaceMkdirArgsSchema.parse(value),
    execute: async (value: unknown, _signal?: AbortSignal, context?: Parameters<ToolDefinition<unknown>["execute"]>[2]) => {
      const args = value as z.infer<typeof workspaceMkdirArgsSchema>;
      const agentId = getCurrentAgentId(context);
      const result = await mkdirAgentWorkspace({ agentId, path: args.path, recursive: args.recursive });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  shared_workspace_list: {
    name: "shared_workspace_list",
    displayName: "Shared Workspace List",
    description:
      "List files and directories inside the shared workspace available to every agent. Use relative paths by default. Recursive listing is optional and stays inside the shared workspace unless the operator explicitly enables outside access on the server.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Optional relative directory path inside the shared workspace. Omit to list the shared workspace root." },
        recursive: { type: "boolean", description: "Whether to include nested files and directories recursively." },
        limit: { type: "number", description: "Maximum number of entries to return. Defaults to 200." },
      },
    },
    validate: (value: unknown) => workspaceListArgsSchema.parse(value),
    execute: async (value: unknown) => {
      const args = value as z.infer<typeof workspaceListArgsSchema>;
      const result = await listSharedWorkspace({ path: args.path, recursive: args.recursive, limit: args.limit });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  shared_workspace_read: {
    name: "shared_workspace_read",
    displayName: "Shared Workspace Read",
    description:
      "Read a text file from the shared workspace using a relative path. Use fromLine and lineCount to inspect large files in focused slices.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Relative file path inside the shared workspace." },
        fromLine: { type: "number", description: "Optional 1-based starting line number." },
        lineCount: { type: "number", description: "Optional number of lines to read. Defaults to 200." },
      },
      required: ["path"],
    },
    validate: (value: unknown) => workspaceReadArgsSchema.parse(value),
    execute: async (value: unknown) => {
      const args = value as z.infer<typeof workspaceReadArgsSchema>;
      const result = await readSharedWorkspaceFile({ path: args.path, fromLine: args.fromLine, lineCount: args.lineCount });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  shared_workspace_write: {
    name: "shared_workspace_write",
    displayName: "Shared Workspace Write",
    description:
      "Create or overwrite a text file inside the shared workspace used for cross-agent collaboration. Parent directories are created automatically.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Relative file path inside the shared workspace." },
        content: { type: "string", description: "Full text content to write into the target file." },
      },
      required: ["path", "content"],
    },
    validate: (value: unknown) => workspaceWriteArgsSchema.parse(value),
    execute: async (value: unknown) => {
      const args = value as z.infer<typeof workspaceWriteArgsSchema>;
      const result = await writeSharedWorkspaceFile({ path: args.path, content: args.content });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  shared_workspace_delete: {
    name: "shared_workspace_delete",
    displayName: "Shared Workspace Delete",
    description:
      "Delete a file or directory inside the shared workspace. Set recursive to true when deleting a non-empty directory. The shared workspace root itself cannot be deleted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Relative path to the file or directory inside the shared workspace." },
        recursive: { type: "boolean", description: "Whether to delete directories recursively." },
      },
      required: ["path"],
    },
    validate: (value: unknown) => workspaceDeleteArgsSchema.parse(value),
    execute: async (value: unknown) => {
      const args = value as z.infer<typeof workspaceDeleteArgsSchema>;
      const result = await deleteSharedWorkspaceEntry({ path: args.path, recursive: args.recursive });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  shared_workspace_append: {
    name: "shared_workspace_append",
    displayName: "Shared Workspace Append",
    description:
      "Append text to the end of a file inside the shared workspace. Create the file automatically if it does not exist yet.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Relative file path inside the shared workspace." },
        content: { type: "string", description: "Text content to append to the target file." },
      },
      required: ["path", "content"],
    },
    validate: (value: unknown) => workspaceAppendArgsSchema.parse(value),
    execute: async (value: unknown) => {
      const args = value as z.infer<typeof workspaceAppendArgsSchema>;
      const result = await appendSharedWorkspaceFile({ path: args.path, content: args.content });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  shared_workspace_move: {
    name: "shared_workspace_move",
    displayName: "Shared Workspace Move",
    description:
      "Rename or move a file or directory inside the shared workspace. The destination must not already exist.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fromPath: { type: "string", description: "Existing relative source path inside the shared workspace." },
        toPath: { type: "string", description: "Relative destination path inside the shared workspace." },
      },
      required: ["fromPath", "toPath"],
    },
    validate: (value: unknown) => workspaceMoveArgsSchema.parse(value),
    execute: async (value: unknown) => {
      const args = value as z.infer<typeof workspaceMoveArgsSchema>;
      const result = await moveSharedWorkspaceEntry({ fromPath: args.fromPath, toPath: args.toPath });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
  shared_workspace_mkdir: {
    name: "shared_workspace_mkdir",
    displayName: "Shared Workspace Mkdir",
    description: "Create a directory inside the shared workspace. Recursive creation is enabled by default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Relative directory path inside the shared workspace." },
        recursive: { type: "boolean", description: "Whether to create missing parent directories automatically." },
      },
      required: ["path"],
    },
    validate: (value: unknown) => workspaceMkdirArgsSchema.parse(value),
    execute: async (value: unknown) => {
      const args = value as z.infer<typeof workspaceMkdirArgsSchema>;
      const result = await mkdirSharedWorkspace({ path: args.path, recursive: args.recursive });
      return createStructuredOutput(result);
    },
  } satisfies ToolDefinition<unknown>,
};
