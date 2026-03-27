import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceSkillCatalogEntry {
  id: string;
  name: string;
  title: string;
  description: string;
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

interface ParsedSkillFrontmatter {
  name?: string;
  description?: string;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function parseSkillFrontmatter(markdown: string): { frontmatter: ParsedSkillFrontmatter; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: markdown };
  }

  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    return { frontmatter: {}, body: markdown };
  }

  const frontmatterText = normalized.slice(4, closingIndex);
  const body = normalized.slice(closingIndex + 5).replace(/^\n+/, "");
  const frontmatter: ParsedSkillFrontmatter = {};

  for (const rawLine of frontmatterText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (!rawValue) {
      continue;
    }

    const value = stripWrappingQuotes(rawValue);
    if (key === "name") {
      frontmatter.name = value;
    } else if (key === "description") {
      frontmatter.description = value;
    }
  }

  return { frontmatter, body };
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
  const rawPrompt = await readFile(sourcePath, "utf8").catch(() => "");
  if (!rawPrompt.trim()) {
    return null;
  }

  const { frontmatter, body } = parseSkillFrontmatter(rawPrompt);
  const prompt = body.trim() || rawPrompt.trim();
  const name = frontmatter.name?.trim() || trimmedId;
  const title = extractTitle(prompt, name);
  const description = frontmatter.description?.trim() || extractSummary(prompt, `${title} skill`);
  return {
    id: trimmedId,
    name,
    title,
    description,
    summary: description,
    prompt,
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
    name: skill.name,
    title: skill.title,
    description: skill.description,
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
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <title>${escapeXml(skill.title)}</title>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <summary>${escapeXml(skill.summary)}</summary>`,
      `    <source>${escapeXml(`skills/${skill.id}/SKILL.md`)}</source>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n\n");
}
