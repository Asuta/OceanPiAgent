import type { ChatSettings, RoomAgentId, RoomToolContext, ToolExecution } from "@/lib/chat/types";

export interface BeforeModelResolveHookArgs {
  agentId?: RoomAgentId;
  settings: ChatSettings;
  toolScope: "default" | "room";
  toolContext?: RoomToolContext;
}

export interface BeforePromptBuildHookArgs extends BeforeModelResolveHookArgs {
  systemPrompt: string;
}

export interface BeforePromptBuildHookResult {
  prependSystemContext?: string;
  appendSystemContext?: string;
}

export interface BeforeToolCallHookArgs {
  agentId?: RoomAgentId;
  toolName: string;
  params: unknown;
  toolScope: "default" | "room";
  toolContext?: RoomToolContext;
}

export interface AfterToolCallHookArgs extends BeforeToolCallHookArgs {
  toolEvent: ToolExecution;
}

export interface BeforeCompactionHookArgs {
  agentId: RoomAgentId;
  reason: "post_turn" | "post_tool" | "manual";
  historyCount: number;
  charsBefore: number;
}

export interface AfterCompactionHookArgs extends BeforeCompactionHookArgs {
  charsAfter: number;
  summary: string;
  prunedMessages: number;
}

type BeforeModelResolveHook = (args: BeforeModelResolveHookArgs) => void | Partial<ChatSettings> | Promise<void | Partial<ChatSettings>>;
type BeforePromptBuildHook = (args: BeforePromptBuildHookArgs) => void | BeforePromptBuildHookResult | Promise<void | BeforePromptBuildHookResult>;
type BeforeToolCallHook = (args: BeforeToolCallHookArgs) => void | Promise<void>;
type AfterToolCallHook = (args: AfterToolCallHookArgs) => void | Promise<void>;
type BeforeCompactionHook = (args: BeforeCompactionHookArgs) => void | Promise<void>;
type AfterCompactionHook = (args: AfterCompactionHookArgs) => void | Promise<void>;

interface RuntimeHookRegistry {
  initialized: boolean;
  beforeModelResolve: BeforeModelResolveHook[];
  beforePromptBuild: BeforePromptBuildHook[];
  beforeToolCall: BeforeToolCallHook[];
  afterToolCall: AfterToolCallHook[];
  beforeCompaction: BeforeCompactionHook[];
  afterCompaction: AfterCompactionHook[];
}

declare global {
  var __oceankingRuntimeHooks: RuntimeHookRegistry | undefined;
}

const runtimeHooks: RuntimeHookRegistry = globalThis.__oceankingRuntimeHooks ?? {
  initialized: false,
  beforeModelResolve: [],
  beforePromptBuild: [],
  beforeToolCall: [],
  afterToolCall: [],
  beforeCompaction: [],
  afterCompaction: [],
};

globalThis.__oceankingRuntimeHooks = runtimeHooks;

export function registerBeforeModelResolveHook(hook: BeforeModelResolveHook): void {
  runtimeHooks.beforeModelResolve.push(hook);
}

export function registerBeforePromptBuildHook(hook: BeforePromptBuildHook): void {
  runtimeHooks.beforePromptBuild.push(hook);
}

export function registerBeforeToolCallHook(hook: BeforeToolCallHook): void {
  runtimeHooks.beforeToolCall.push(hook);
}

export function registerAfterToolCallHook(hook: AfterToolCallHook): void {
  runtimeHooks.afterToolCall.push(hook);
}

export function registerBeforeCompactionHook(hook: BeforeCompactionHook): void {
  runtimeHooks.beforeCompaction.push(hook);
}

export function registerAfterCompactionHook(hook: AfterCompactionHook): void {
  runtimeHooks.afterCompaction.push(hook);
}

export async function ensureRuntimeHooksInitialized(): Promise<void> {
  if (runtimeHooks.initialized) {
    return;
  }

  runtimeHooks.initialized = true;
  await import("./runtime-hooks.builtin");
}

export async function runBeforeModelResolveHooks(args: BeforeModelResolveHookArgs): Promise<ChatSettings> {
  await ensureRuntimeHooksInitialized();
  let nextSettings = { ...args.settings };
  for (const hook of runtimeHooks.beforeModelResolve) {
    const result = await hook({ ...args, settings: nextSettings });
    if (!result) {
      continue;
    }

    nextSettings = {
      ...nextSettings,
      ...result,
    };
  }

  return nextSettings;
}

export async function runBeforePromptBuildHooks(args: BeforePromptBuildHookArgs): Promise<string> {
  await ensureRuntimeHooksInitialized();
  const prependBlocks: string[] = [];
  const appendBlocks: string[] = [];

  for (const hook of runtimeHooks.beforePromptBuild) {
    const result = await hook(args);
    if (!result) {
      continue;
    }
    if (result.prependSystemContext?.trim()) {
      prependBlocks.push(result.prependSystemContext.trim());
    }
    if (result.appendSystemContext?.trim()) {
      appendBlocks.push(result.appendSystemContext.trim());
    }
  }

  return [
    ...prependBlocks,
    args.systemPrompt.trim(),
    ...appendBlocks,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function runBeforeToolCallHooks(args: BeforeToolCallHookArgs): Promise<void> {
  await ensureRuntimeHooksInitialized();
  for (const hook of runtimeHooks.beforeToolCall) {
    await hook(args);
  }
}

export async function runAfterToolCallHooks(args: AfterToolCallHookArgs): Promise<void> {
  await ensureRuntimeHooksInitialized();
  for (const hook of runtimeHooks.afterToolCall) {
    await hook(args);
  }
}

export async function runBeforeCompactionHooks(args: BeforeCompactionHookArgs): Promise<void> {
  await ensureRuntimeHooksInitialized();
  for (const hook of runtimeHooks.beforeCompaction) {
    await hook(args);
  }
}

export async function runAfterCompactionHooks(args: AfterCompactionHookArgs): Promise<void> {
  await ensureRuntimeHooksInitialized();
  for (const hook of runtimeHooks.afterCompaction) {
    await hook(args);
  }
}
