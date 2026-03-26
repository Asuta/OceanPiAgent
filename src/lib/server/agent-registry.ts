import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOM_AGENTS } from "@/lib/chat/catalog";
import type { RoomAgentDefinition, RoomAgentId } from "@/lib/chat/types";
import { getAgentWorkspaceDir, getAgentWorkspaceRootDir } from "@/lib/server/agent-workspace-store";

const AGENT_META_DIR = ".agent";
const PROFILE_FILE = "profile.json";
const PROMPT_FILE = "system-prompt.md";
const MAX_SKILLS = 24;
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/;

interface PersistedAgentProfile {
  id: string;
  label: string;
  summary: string;
  skills: string[];
  workingStyle: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredRoomAgentDefinition extends RoomAgentDefinition {
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentDefinitionInput {
  id: string;
  label: string;
  summary: string;
  skills?: string[];
  workingStyle: string;
  instruction: string;
}

export interface UpdateAgentDefinitionInput {
  label?: string;
  summary?: string;
  skills?: string[];
  workingStyle?: string;
  instruction?: string;
}

function createTimestamp(): string {
  return new Date().toISOString();
}

function normalizeSkills(skills: unknown): string[] {
  if (!Array.isArray(skills)) {
    return [];
  }

  return [...new Set(skills.filter((skill): skill is string => typeof skill === "string").map((skill) => skill.trim()).filter(Boolean))].slice(0, MAX_SKILLS);
}

function assertAgentId(agentId: string): asserts agentId is RoomAgentId {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error("Agent id must use lowercase letters, numbers, underscores, or hyphens.");
  }
}

function createProfilePath(agentId: RoomAgentId): string {
  return path.join(getAgentWorkspaceDir(agentId), AGENT_META_DIR, PROFILE_FILE);
}

function createPromptPath(agentId: RoomAgentId): string {
  return path.join(getAgentWorkspaceDir(agentId), AGENT_META_DIR, PROMPT_FILE);
}

async function ensureAgentMetaDir(agentId: RoomAgentId): Promise<void> {
  await mkdir(path.join(getAgentWorkspaceDir(agentId), AGENT_META_DIR), { recursive: true });
}

async function hasPersistedAgentFiles(agentId: RoomAgentId): Promise<boolean> {
  const [profileText, promptText] = await Promise.all([
    readFile(createProfilePath(agentId), "utf8").catch(() => ""),
    readFile(createPromptPath(agentId), "utf8").catch(() => ""),
  ]);
  return Boolean(profileText.trim() || promptText.trim());
}

function buildStoredDefinition(args: {
  agentId: RoomAgentId;
  profile?: Partial<PersistedAgentProfile>;
  instruction?: string;
  fallback?: RoomAgentDefinition;
}): StoredRoomAgentDefinition {
  const fallback = args.fallback;
  const now = createTimestamp();
  return {
    id: args.agentId,
    label: typeof args.profile?.label === "string" && args.profile.label.trim() ? args.profile.label.trim() : fallback?.label || args.agentId,
    summary: typeof args.profile?.summary === "string" && args.profile.summary.trim()
      ? args.profile.summary.trim()
      : fallback?.summary || `Custom agent ${args.agentId}.`,
    skills: normalizeSkills(args.profile?.skills ?? fallback?.skills ?? []),
    workingStyle: typeof args.profile?.workingStyle === "string" && args.profile.workingStyle.trim()
      ? args.profile.workingStyle.trim()
      : fallback?.workingStyle || "Custom, workspace-backed agent.",
    instruction: typeof args.instruction === "string"
      ? args.instruction.trim()
      : fallback?.instruction || "",
    createdAt: typeof args.profile?.createdAt === "string" && args.profile.createdAt ? args.profile.createdAt : now,
    updatedAt: typeof args.profile?.updatedAt === "string" && args.profile.updatedAt ? args.profile.updatedAt : now,
  };
}

async function writeStoredDefinition(definition: StoredRoomAgentDefinition): Promise<void> {
  await ensureAgentMetaDir(definition.id);
  const profile: PersistedAgentProfile = {
    id: definition.id,
    label: definition.label,
    summary: definition.summary,
    skills: [...definition.skills],
    workingStyle: definition.workingStyle,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  };
  await Promise.all([
    writeFile(createProfilePath(definition.id), JSON.stringify(profile, null, 2), "utf8"),
    writeFile(createPromptPath(definition.id), `${definition.instruction.trim()}\n`, "utf8"),
  ]);
}

async function readStoredDefinition(agentId: RoomAgentId): Promise<StoredRoomAgentDefinition | null> {
  const fallback = ROOM_AGENTS.find((agent) => agent.id === agentId);
  const [profileText, promptText] = await Promise.all([
    readFile(createProfilePath(agentId), "utf8").catch(() => ""),
    readFile(createPromptPath(agentId), "utf8").catch(() => ""),
  ]);

  if (!profileText.trim() && !promptText.trim() && !fallback) {
    return null;
  }

  let parsedProfile: Partial<PersistedAgentProfile> | undefined;
  if (profileText.trim()) {
    try {
      parsedProfile = JSON.parse(profileText) as Partial<PersistedAgentProfile>;
    } catch {
      parsedProfile = undefined;
    }
  }

  return buildStoredDefinition({
    agentId,
    profile: parsedProfile,
    instruction: promptText,
    fallback,
  });
}

function sortDefinitions(definitions: StoredRoomAgentDefinition[]): StoredRoomAgentDefinition[] {
  const builtinOrder = new Map(ROOM_AGENTS.map((agent, index) => [agent.id, index]));
  return [...definitions].sort((left, right) => {
    const leftBuiltin = builtinOrder.get(left.id);
    const rightBuiltin = builtinOrder.get(right.id);
    if (typeof leftBuiltin === "number" || typeof rightBuiltin === "number") {
      if (typeof leftBuiltin !== "number") {
        return 1;
      }
      if (typeof rightBuiltin !== "number") {
        return -1;
      }
      return leftBuiltin - rightBuiltin;
    }

    return left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
  });
}

export async function ensureDefaultAgentDefinitions(): Promise<void> {
  await Promise.all(
    ROOM_AGENTS.map(async (agent) => {
      if (await hasPersistedAgentFiles(agent.id)) {
        return;
      }

      const timestamp = createTimestamp();
      await writeStoredDefinition({
        ...agent,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }),
  );
}

export async function listAgentDefinitions(): Promise<StoredRoomAgentDefinition[]> {
  await ensureDefaultAgentDefinitions();
  await mkdir(getAgentWorkspaceRootDir(), { recursive: true });
  const entries = await readdir(getAgentWorkspaceRootDir(), { withFileTypes: true });
  const agentIds = entries
    .filter((entry) => entry.isDirectory() && entry.name !== "_shared")
    .map((entry) => entry.name)
    .filter((agentId) => AGENT_ID_PATTERN.test(agentId));

  const definitions = await Promise.all(agentIds.map((agentId) => readStoredDefinition(agentId)));
  return sortDefinitions(definitions.filter((definition): definition is StoredRoomAgentDefinition => Boolean(definition)));
}

export async function getAgentDefinition(agentId: RoomAgentId): Promise<StoredRoomAgentDefinition | null> {
  await ensureDefaultAgentDefinitions();
  return readStoredDefinition(agentId);
}

export async function createAgentDefinition(input: CreateAgentDefinitionInput): Promise<StoredRoomAgentDefinition> {
  const agentId = input.id.trim();
  assertAgentId(agentId);
  await ensureDefaultAgentDefinitions();

  const existing = await readStoredDefinition(agentId);
  if (existing) {
    throw new Error(`Agent ${agentId} already exists.`);
  }

  const timestamp = createTimestamp();
  const definition = buildStoredDefinition({
    agentId,
    profile: {
      id: agentId,
      label: input.label,
      summary: input.summary,
      skills: input.skills,
      workingStyle: input.workingStyle,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    instruction: input.instruction,
  });
  await writeStoredDefinition(definition);
  return definition;
}

export async function updateAgentDefinition(agentId: RoomAgentId, patch: UpdateAgentDefinitionInput): Promise<StoredRoomAgentDefinition> {
  const current = await getAgentDefinition(agentId);
  if (!current) {
    throw new Error("Agent not found.");
  }

  const nextDefinition: StoredRoomAgentDefinition = {
    ...current,
    label: typeof patch.label === "string" && patch.label.trim() ? patch.label.trim() : current.label,
    summary: typeof patch.summary === "string" && patch.summary.trim() ? patch.summary.trim() : current.summary,
    skills: Array.isArray(patch.skills) ? normalizeSkills(patch.skills) : current.skills,
    workingStyle: typeof patch.workingStyle === "string" && patch.workingStyle.trim() ? patch.workingStyle.trim() : current.workingStyle,
    instruction: typeof patch.instruction === "string" ? patch.instruction.trim() : current.instruction,
    updatedAt: createTimestamp(),
  };
  await writeStoredDefinition(nextDefinition);
  return nextDefinition;
}
