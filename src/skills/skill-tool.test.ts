import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoadSkillTool } from "./skill-tool.js";
import type { LoadedSkill } from "./loader.js";

function makeSkill(name: string, description: string, body: string): LoadedSkill {
  return { name, description, body, filePath: `/fake/${name}/SKILL.md` };
}

test("returns the matching skill's body", async () => {
  const skills = [makeSkill("tdd", "Test-driven development.", "Red, green, refactor.")];
  const tool = createLoadSkillTool(skills);

  const result = await tool.execute({ name: "tdd" });
  assert.equal(result, "Red, green, refactor.");
});

test("lists all skills in the tool description", () => {
  const skills = [
    makeSkill("tdd", "Test-driven development.", "..."),
    makeSkill("code-review", "Review a diff.", "..."),
  ];
  const tool = createLoadSkillTool(skills);

  assert.match(tool.description, /tdd/);
  assert.match(tool.description, /Test-driven development/);
  assert.match(tool.description, /code-review/);
});

test("returns a clear error for an unknown skill name", async () => {
  const skills = [makeSkill("tdd", "Test-driven development.", "...")];
  const tool = createLoadSkillTool(skills);

  const result = await tool.execute({ name: "does-not-exist" });
  assert.match(result, /no skill named "does-not-exist"/);
  assert.match(result, /tdd/); // lists what IS available
});

test("rejects a missing name argument", async () => {
  const tool = createLoadSkillTool([makeSkill("tdd", "Test-driven development.", "...")]);
  const result = await tool.execute({});
  assert.match(result, /missing or invalid/);
});

test("rejects a non-string name argument", async () => {
  const tool = createLoadSkillTool([makeSkill("tdd", "Test-driven development.", "...")]);
  const result = await tool.execute({ name: 42 });
  assert.match(result, /missing or invalid/);
});

test("handles an empty skill list gracefully", async () => {
  const tool = createLoadSkillTool([]);
  assert.match(tool.description, /none found/);

  const result = await tool.execute({ name: "anything" });
  assert.match(result, /no skill named/);
});
