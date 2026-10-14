// Tools that can be refused: by the user in the chat app, or by the policy
// during an eval. Only these can produce a "declined" result.
const REFUSABLE_TOOLS = new Set(["write_file", "edit_file", "run_command"]);

// True when a tool call was declined rather than run.
//
// Only the FIRST LINE of the result is examined, and only for tools that can
// be refused. Looking at the whole text of any tool's result would mistake
// ordinary content for a refusal: reading a source file that happens to
// contain the phrase "declined by the user", or a command whose output
// mentions it, is not a declined action. (A command that really ran starts
// with an "[Exit code: ...]" line, so its output can never match.)
export function isDeclinedResult(toolName: string, result: string): boolean {
  if (!REFUSABLE_TOOLS.has(toolName)) return false;
  return /\bdeclined\b/i.test(result.split("\n", 1)[0] ?? "");
}
