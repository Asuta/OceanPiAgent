import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceSkill {
  id: string;
  title: string;
  summary: string;
  prompt: string;
  sourcePath: string;
}

const SKILLS_DIR = path.join(process.cwd(), "skills");

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
  await mkdir(SKILLS_DIR, { recursive: true });
}

export async function listWorkspaceSkills(): Promise<WorkspaceSkill[]> {
  await ensureWorkspaceSkillsDir();
  const dirEntries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const skills = await Promise.all(
    dirEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const skillId = entry.name;
        const sourcePath = path.join(SKILLS_DIR, skillId, "SKILL.md");
        const prompt = await readFile(sourcePath, "utf8").catch(() => "");
        if (!prompt.trim()) {
          return null;
        }

        const title = extractTitle(prompt, skillId);
        return {
          id: skillId,
          title,
          summary: extractSummary(prompt, `${title} skill`),
          prompt: prompt.trim(),
          sourcePath,
        } satisfies WorkspaceSkill;
      }),
  );

  return skills.filter((skill): skill is WorkspaceSkill => Boolean(skill)).sort((left, right) => left.title.localeCompare(right.title));
}

export async function getWorkspaceSkillsByIds(skillIds: string[]): Promise<WorkspaceSkill[]> {
  const normalizedIds = [...new Set(skillIds.map((skillId) => skillId.trim()).filter(Boolean))];
  if (normalizedIds.length === 0) {
    return [];
  }

  const skills = await listWorkspaceSkills();
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return normalizedIds.flatMap((skillId) => (byId.get(skillId) ? [byId.get(skillId)!] : []));
}

export function buildSkillsPrompt(skills: WorkspaceSkill[]): string {
  if (skills.length === 0) {
    return "";
  }

  return [
    "Enabled workspace skills:",
    ...skills.map((skill) => `## ${skill.title}\nSource: skills/${skill.id}/SKILL.md\n\n${skill.prompt}`),
  ].join("\n\n");
}
