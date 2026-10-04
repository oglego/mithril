import type { Tool } from "../types.js";
import type { LoadedSkill } from "./loader.js";

// A factory, like createSearchDocsTool — needs to close over the skills
// discovered at startup, which only exist once --skills has been provided.
export function createLoadSkillTool(skills: LoadedSkill[]): Tool {
  const catalog =
    skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n") || "(none found)";

  return {
    name: "load_skill",
    description: [
      "Load detailed instructions for a specific skill by name. Call this " +
        "before attempting a task that matches one of the skills below — " +
        "the loaded instructions should take priority over your own default approach.",
      "",
      "Available skills:",
      catalog,
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The exact name of the skill to load, from the list above." },
      },
      required: ["name"],
    },
    execute: async (args) => {
      const name = args.name;

      if (typeof name !== "string" || name.length === 0) {
        return 'Error: missing or invalid "name" argument.';
      }

      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ") || "(none)";
        return `Error: no skill named "${name}" was found. Available: ${available}`;
      }

      // Note for a future iteration: some skills (e.g. mattpocock/skills'
      // tdd) reference sibling files like tests.md or mocking.md by
      // relative path. Mithril doesn't auto-expand those yet, but since
      // skill files typically live inside the project directory, the
      // model can already follow up with read_file for any it needs.
      return skill.body;
    },
  };
}
