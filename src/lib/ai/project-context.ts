import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface ProjectContextFileEntry {
  path: string;
  summary: string;
  bytes: number;
}

export interface ProjectContextReadResult {
  path: string;
  fromLine: number;
  lineCount: number;
  updatedAt: string;
  text: string;
}

interface LoadedProjectContextFile extends ProjectContextFileEntry {
  absolutePath: string;
  updatedAt: string;
  content: string;
}

function toProjectContextFileEntry(entry: LoadedProjectContextFile): ProjectContextFileEntry {
  return {
    path: entry.path,
    summary: entry.summary,
    bytes: entry.bytes,
  };
}

const ROOT_BOOTSTRAP_FILES = ["PROJECT_CONTEXT.md", "AGENTS.md", "SOUL.md", "TOOLS.md"] as const;
const ROOT_CATALOG_FILES = [
  ...ROOT_BOOTSTRAP_FILES,
  "AGENTS.md",
  "README.md",
  "OceanKing-Agent-Roadmap.md",
] as const;
const DOCS_DIR = "docs";
const DOCS_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const DEFAULT_READ_LINE_COUNT = 200;
const MAX_READ_LINE_COUNT = 400;
const MAX_BOOTSTRAP_FILE_CHARS = 4_000;
const MAX_BOOTSTRAP_TOTAL_CHARS = 12_000;
const MAX_DOC_FILES = 100;

function extractSummary(markdown: string, fallback: string): string {
  const lines = markdown
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  const summaryLine = lines.find((line) => !line.startsWith("#") && !line.startsWith("- "));
  return summaryLine || fallback;
}

function clampLineWindow(totalLines: number, fromLine?: number, lineCount?: number): { start: number; end: number } {
  if (totalLines === 0) {
    return { start: 0, end: 0 };
  }

  const safeStart = typeof fromLine === "number" && Number.isFinite(fromLine) ? Math.max(1, Math.round(fromLine)) : 1;
  const requestedCount = typeof lineCount === "number" && Number.isFinite(lineCount)
    ? Math.max(1, Math.min(MAX_READ_LINE_COUNT, Math.round(lineCount)))
    : DEFAULT_READ_LINE_COUNT;
  const start = Math.min(totalLines, safeStart) - 1;
  const end = Math.min(totalLines, start + requestedCount);
  return { start, end };
}

function getProjectRoot(): string {
  return process.cwd();
}

function isAllowedRootContextFile(filePath: string): boolean {
  return ROOT_CATALOG_FILES.includes(filePath as (typeof ROOT_CATALOG_FILES)[number]);
}

function isAllowedDocsFile(filePath: string): boolean {
  const normalizedPath = filePath.replaceAll("\\", "/");
  if (!normalizedPath.startsWith(`${DOCS_DIR}/`)) {
    return false;
  }
  return DOCS_EXTENSIONS.has(path.extname(normalizedPath).toLowerCase());
}

function isAllowedProjectContextPath(filePath: string): boolean {
  return isAllowedRootContextFile(filePath) || isAllowedDocsFile(filePath);
}

function resolveProjectContextPath(relativePath: string): string {
  const trimmedPath = relativePath.trim();
  if (!trimmedPath) {
    throw new Error("A project context path is required.");
  }

  const normalizedPath = trimmedPath.replaceAll("\\", "/");
  if (!isAllowedProjectContextPath(normalizedPath)) {
    throw new Error(`Unsupported project context path: ${trimmedPath}`);
  }

  const absolutePath = path.resolve(getProjectRoot(), normalizedPath);
  const rootPath = getProjectRoot();
  const relativeResolvedPath = path.relative(rootPath, absolutePath).replaceAll("\\", "/");
  if (relativeResolvedPath.startsWith("..") || path.isAbsolute(relativeResolvedPath)) {
    throw new Error("Project context access is limited to the current workspace root.");
  }

  if (!isAllowedProjectContextPath(relativeResolvedPath)) {
    throw new Error(`Unsupported project context path: ${trimmedPath}`);
  }

  return absolutePath;
}

async function readAllowedProjectContextFile(relativePath: string): Promise<LoadedProjectContextFile | null> {
  const absolutePath = resolveProjectContextPath(relativePath);
  const fileStat = await stat(absolutePath).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    return null;
  }

  const content = await readFile(absolutePath, "utf8");
  return {
    path: relativePath.replaceAll("\\", "/"),
    summary: extractSummary(content, relativePath),
    bytes: fileStat.size,
    absolutePath,
    updatedAt: fileStat.mtime.toISOString(),
    content,
  };
}

async function listDocsContextFiles(): Promise<ProjectContextFileEntry[]> {
  const docsRoot = path.join(getProjectRoot(), DOCS_DIR);
  const docsRootStat = await stat(docsRoot).catch(() => null);
  if (!docsRootStat?.isDirectory()) {
    return [];
  }

  const results: ProjectContextFileEntry[] = [];
  const stack = [docsRoot];
  while (stack.length > 0 && results.length < MAX_DOC_FILES) {
    const currentDir = stack.pop() as string;
    const dirEntries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (results.length >= MAX_DOC_FILES) {
        break;
      }

      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(getProjectRoot(), absolutePath).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !isAllowedDocsFile(relativePath)) {
        continue;
      }

      const loaded = await readAllowedProjectContextFile(relativePath);
      if (!loaded) {
        continue;
      }
      results.push({ path: loaded.path, summary: loaded.summary, bytes: loaded.bytes });
    }
  }

  return results.sort((left, right) => left.path.localeCompare(right.path));
}

export async function listProjectContextFiles(): Promise<ProjectContextFileEntry[]> {
  const rootFiles = await Promise.all(
    ROOT_CATALOG_FILES.map(async (fileName) => readAllowedProjectContextFile(fileName)),
  );

  return [
    ...rootFiles
      .filter((entry): entry is LoadedProjectContextFile => Boolean(entry))
      .map((entry) => toProjectContextFileEntry(entry)),
    ...(await listDocsContextFiles()),
  ].sort((left, right) => left.path.localeCompare(right.path));
}

export async function readProjectContextFile(args: {
  path: string;
  fromLine?: number;
  lineCount?: number;
}): Promise<ProjectContextReadResult> {
  const loaded = await readAllowedProjectContextFile(args.path);
  if (!loaded) {
    throw new Error(`Project context file not found: ${args.path}`);
  }

  const allLines = loaded.content.split(/\r?\n/g);
  const { start, end } = clampLineWindow(allLines.length, args.fromLine, args.lineCount);

  return {
    path: loaded.path,
    fromLine: start + 1,
    lineCount: Math.max(0, end - start),
    updatedAt: loaded.updatedAt,
    text: allLines.slice(start, end).join("\n"),
  };
}

export async function buildProjectContextPrompt(): Promise<string> {
  const catalogEntries = await listProjectContextFiles();
  const injectedFiles: Array<{ path: string; content: string }> = [];
  let totalChars = 0;

  for (const fileName of ROOT_BOOTSTRAP_FILES) {
    const loaded = await readAllowedProjectContextFile(fileName);
    if (!loaded) {
      continue;
    }

    const trimmedContent = loaded.content.trim();
    if (!trimmedContent) {
      continue;
    }

    const nextContent = trimmedContent.length > MAX_BOOTSTRAP_FILE_CHARS
      ? `${trimmedContent.slice(0, MAX_BOOTSTRAP_FILE_CHARS)}\n\n[truncated]`
      : trimmedContent;
    if (totalChars + nextContent.length > MAX_BOOTSTRAP_TOTAL_CHARS) {
      break;
    }

    totalChars += nextContent.length;
    injectedFiles.push({ path: loaded.path, content: nextContent });
  }

  if (catalogEntries.length === 0 && injectedFiles.length === 0) {
    return "";
  }

  const lines = [
    "Project context catalog:",
    "Use project_context_list or project_context_read when local project docs or runtime guidance would help.",
  ];

  if (catalogEntries.length > 0) {
    lines.push(
      "Available project context files:",
      ...catalogEntries.map((entry) => `- ${entry.path}: ${entry.summary}`),
    );
  }

  if (injectedFiles.length > 0) {
    lines.push("", "Injected project context:");
    for (const file of injectedFiles) {
      lines.push("", `## ${file.path}`, "", file.content);
    }
  }

  return lines.join("\n").trim();
}
