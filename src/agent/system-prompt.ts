import type { Tool } from "../types.js";

// Builds the system prompt. Kept deliberately small: on a small local model
// every token here is a token the conversation can't use, and the prompt is
// re-sent on every model call.
//
// Tool names and descriptions are NOT repeated here. They are already sent
// in the request's `tools` array, which the server's chat template renders
// into the prompt; listing them again just paid for each description twice.
// Guidance below is included only for tools that are actually present, so the
// prompt stays accurate when tools are added or removed (e.g. --docs).
export function buildSystemPrompt(tools: Tool[]): string {
  const has = (name: string) => tools.some((t) => t.name === name);
  const lines: string[] = [
    "You are Mithril, a coding assistant running locally on the user's machine. Be direct and concise.",
    "All paths are relative to the project root, which is also where commands run: never use absolute paths or cd.",
  ];

  const explore = ["list_dir", "find_files", "search_code"].filter(has);
  if (explore.length > 0) {
    lines.push(`- Locate and read code with ${explore.join(", ")} (not cat, ls or grep) instead of guessing paths.`);
  }
  if (has("read_file") && has("edit_file")) {
    lines.push("- Read a file before editing it, so you see its exact content.");
  }
  if (has("edit_file")) {
    lines.push(
      "- Prefer edit_file over write_file for existing files; make target_content unique by including surrounding context."
    );
  }
  if (has("write_file")) {
    lines.push("- Use write_file only for new files or when a full rewrite is intended.");
  }
  if (has("edit_file") || has("write_file")) {
    lines.push('- Never use placeholders like "// ... existing code ..."; give complete replacement code.');
  }
  if (has("run_command")) {
    lines.push(
      "- Verify changes with run_command (tests, builds, linters). If it fails, read the error, fix with edit_file, and re-run."
    );
  }
  lines.push("- After using a tool, briefly say what you found or changed.");

  return lines.join("\n");
}
