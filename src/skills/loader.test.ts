import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkills } from "./loader.js";

let skillsRoot: string;

before(async () => {
  skillsRoot = await mkdtemp(path.join(tmpdir(), "mithril-skills-test-"));

  // A flat skill.
  await mkdir(path.join(skillsRoot, "tdd"), { recursive: true });
  await writeFile(
    path.join(skillsRoot, "tdd", "SKILL.md"),
    [
      "---",
      "name: tdd",
      "description: Test-driven development workflow. Use when implementing features test-first.",
      "---",
      "",
      "# TDD",
      "",
      "Write a failing test first, then make it pass, then refactor.",
    ].join("\n")
  );

  // A nested skill, matching the community convention (skills/<category>/<name>/SKILL.md).
  await mkdir(path.join(skillsRoot, "engineering", "code-review"), { recursive: true });
  await writeFile(
    path.join(skillsRoot, "engineering", "code-review", "SKILL.md"),
    ["---", "name: code-review", "description: Review a diff for design issues.", "---", "", "Look for deep modules."].join(
      "\n"
    )
  );

  // A malformed skill file — missing the description field — should be
  // skipped, not crash the whole load.
  await mkdir(path.join(skillsRoot, "broken"), { recursive: true });
  await writeFile(
    path.join(skillsRoot, "broken", "SKILL.md"),
    ["---", "name: broken", "---", "", "No description field above."].join("\n")
  );

  // A file with no frontmatter at all — also skipped, not crashed on.
  await mkdir(path.join(skillsRoot, "not-a-skill"), { recursive: true });
  await writeFile(path.join(skillsRoot, "not-a-skill", "SKILL.md"), "Just plain text, no frontmatter.");

  // A non-SKILL.md markdown file nearby — should be ignored entirely.
  await writeFile(path.join(skillsRoot, "README.md"), "# Not a skill file");
});

after(async () => {
  await rm(skillsRoot, { recursive: true, force: true });
});

test("loads a flat skill with valid frontmatter", async () => {
  const skills = await loadSkills(skillsRoot);
  const tdd = skills.find((s) => s.name === "tdd");

  assert.ok(tdd, "expected to find the tdd skill");
  assert.equal(tdd?.description, "Test-driven development workflow. Use when implementing features test-first.");
  assert.match(tdd?.body ?? "", /Write a failing test first/);
});

test("discovers skills nested under category folders", async () => {
  const skills = await loadSkills(skillsRoot);
  const review = skills.find((s) => s.name === "code-review");

  assert.ok(review, "expected to find the nested code-review skill");
  assert.match(review?.body ?? "", /deep modules/);
});

test("skips a SKILL.md missing required frontmatter fields", async () => {
  const skills = await loadSkills(skillsRoot);
  assert.equal(skills.find((s) => s.name === "broken"), undefined);
});

test("skips a file with no frontmatter block at all", async () => {
  const skills = await loadSkills(skillsRoot);
  // The "not-a-skill" file has no name, so it can't match any skill by name —
  // confirm the total count reflects only the two genuinely valid skills.
  assert.equal(skills.length, 2);
});

test("ignores markdown files that aren't named SKILL.md", async () => {
  const skills = await loadSkills(skillsRoot);
  assert.equal(
    skills.some((s) => s.filePath.endsWith("README.md")),
    false
  );
});

test("returns an empty array for a directory with no skills", async () => {
  const emptyDir = await mkdtemp(path.join(tmpdir(), "mithril-empty-"));
  try {
    const skills = await loadSkills(emptyDir);
    assert.deepEqual(skills, []);
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
});
