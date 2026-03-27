import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceSkillCatalogEntry {
  id: string;
  title: string;
  summary: string;
  sourcePath: string;
}

export interface WorkspaceSkill extends WorkspaceSkillCatalogEntry {
  prompt: string;
}

function getSkillsDir(): string {
  return path.join(process.cwd(), "skills");
}

function slugToTitle(value: string): string {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractSummary(markdown: string, fallback: string): string {
  const lines = markdown
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  const summaryLine = lines.find((line) => !line.startsWith("#") && !line.startsWith("- "));
  return summaryLine || fallback;
}

function extractTitle(markdown: string, fallbackId: string): string {
  const heading = markdown
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "));

  return heading ? heading.replace(/^#\s+/, "").trim() : slugToTitle(fallbackId);
}

export async function ensureWorkspaceSkillsDir(): Promise<void> {
  await mkdir(getSkillsDir(), { recursive: true });
}

async function loadWorkspaceSkill(skillId: string): Promise<WorkspaceSkill | null> {
  const trimmedId = skillId.trim();
  if (!trimmedId) {
    return null;
  }

  const sourcePath = path.join(getSkillsDir(), trimmedId, "SKILL.md");
  const prompt = await readFile(sourcePath, "utf8").catch(() => "");
  if (!prompt.trim()) {
    return null;
  }

  const title = extractTitle(prompt, trimmedId);
  return {
    id: trimmedId,
    title,
    summary: extractSummary(prompt, `${title} skill`),
    prompt: prompt.trim(),
    sourcePath,
  } satisfies WorkspaceSkill;
}

export async function listWorkspaceSkills(): Promise<WorkspaceSkillCatalogEntry[]> {
  await ensureWorkspaceSkillsDir();
  const dirEntries = await readdir(getSkillsDir(), { withFileTypes: true });
  const skills = await Promise.all(
    dirEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => loadWorkspaceSkill(entry.name)),
  );

  return skills
    .filter((skill): skill is WorkspaceSkill => Boolean(skill))
    .map((skill) => toSkillCatalogEntry(skill))
    .sort((left, right) => left.title.localeCompare(right.title));
}

export async function getWorkspaceSkillsByIds(skillIds: string[]): Promise<WorkspaceSkill[]> {
  const normalizedIds = [...new Set(skillIds.map((skillId) => skillId.trim()).filter(Boolean))];
  if (normalizedIds.length === 0) {
    return [];
  }

  const skills = await Promise.all(normalizedIds.map((skillId) => loadWorkspaceSkill(skillId)));
  return skills.filter((skill): skill is WorkspaceSkill => Boolean(skill));
}

export async function getWorkspaceSkillById(skillId: string): Promise<WorkspaceSkill | null> {
  return loadWorkspaceSkill(skillId);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toSkillCatalogEntry(skill: WorkspaceSkill): WorkspaceSkillCatalogEntry {
  return {
    id: skill.id,
    title: skill.title,
    summary: skill.summary,
    sourcePath: skill.sourcePath,
  };
}

export function buildSkillsCatalogPrompt(skills: WorkspaceSkillCatalogEntry[]): string {
  if (skills.length === 0) {
    return "";
  }

  return [
    "Enabled workspace skills:",
    "Review this catalog before replying. Read a skill only when one entry clearly matches the task.",
    "<available_skills>",
    ...skills.flatMap((skill) => [
      "  <skill>",
      `    <id>${escapeXml(skill.id)}</id>`,
      `    <title>${escapeXml(skill.title)}</title>`,
      `    <summary>${escapeXml(skill.summary)}</summary>`,
      `    <source>${escapeXml(`skills/${skill.id}/SKILL.md`)}</source>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n\n");
}
