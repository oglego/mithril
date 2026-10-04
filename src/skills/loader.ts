import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface LoadedSkill {
  name: string;
  description: string;
  filePath: string;
  body: string;
}

async function findSkillFiles(dir: string): Promise<string[]> {
  // { recursive: true } walks subdirectories too — skills from the
  // community ecosystem (e.g. mattpocock/skills) nest under category
  // folders like skills/engineering/tdd/SKILL.md, not flat.
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name === "SKILL.md") {
      const parent = (entry as { parentPath?: string }).parentPath ?? dir;
      files.push(path.join(parent, entry.name));
    }
  }

  return files;
}

// Parses a SKILL.md file: a "name:" / "description:" YAML frontmatter block
// (---  ... ---) followed by the instructional body. This is the same
// convention used by Claude Code, Codex, and the broader community skills
// ecosystem (e.g. mattpocock/skills) — matching it means skill packs built
// for those tools work here without modification.
function parseSkillMd(raw: string): { name: string; description: string; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const [, frontmatter, body] = match;
  const name = frontmatter?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter?.match(/^description:\s*(.+)$/m)?.[1]?.trim();

  if (!name || !description) return null;

  return { name, description, body: (body ?? "").trim() };
}

// Discovers and parses every SKILL.md under a directory. Files that don't
// match the expected frontmatter format are skipped rather than treated as
// a startup error — a malformed or unrelated file in someone's skills
// folder shouldn't prevent Mithril from starting.
export async function loadSkills(skillsDir: string): Promise<LoadedSkill[]> {
  const files = await findSkillFiles(skillsDir);
  const skills: LoadedSkill[] = [];

  for (const filePath of files) {
    const raw = await readFile(filePath, "utf-8");
    const parsed = parseSkillMd(raw);
    if (!parsed) continue;
    skills.push({ ...parsed, filePath });
  }

  return skills;
}
