import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  readFileTool,
  listDirTool,
  findFilesTool,
  searchCodeTool,
  createWriteFileTool,
  createEditFileTool,
  createRunCommandTool,
  toolsToApiFormat,
} from "./tools.js";
import { estimateTokens } from "./context.js";
import type { Tool } from "../types.js";

const noop = async () => true;
const fullToolset = (): Tool[] => [
  readFileTool,
  listDirTool,
  findFilesTool,
  searchCodeTool,
  createWriteFileTool({ confirm: noop }),
  createEditFileTool({ confirm: noop }),
  createRunCommandTool({ confirmCommand: noop }),
];

function fixedOverhead(tools: Tool[]): { system: number; defs: number; total: number } {
  const system = estimateTokens(buildSystemPrompt(tools));
  const defs = estimateTokens(JSON.stringify(toolsToApiFormat(tools)));
  return { system, defs, total: system + defs };
}

// Mithril's pitch is that it works on small local models, where context is
// scarce and this overhead is paid on EVERY model call. This test is a budget:
// if it fails, a change made the agent more expensive to run. Either slim the
// change down, or raise the limit deliberately and say why in the commit.
const FIXED_OVERHEAD_BUDGET_TOKENS = 900; // was ~1,570 before the slimming pass, now ~830

test("fixed prompt overhead (system prompt + tool definitions) stays within budget", () => {
  const { system, defs, total } = fixedOverhead(fullToolset());
  assert.ok(
    total <= FIXED_OVERHEAD_BUDGET_TOKENS,
    `fixed overhead is ~${total} tokens (system ${system} + tool definitions ${defs}); budget is ${FIXED_OVERHEAD_BUDGET_TOKENS}`
  );
});

test("tool descriptions are not duplicated into the system prompt", () => {
  const prompt = buildSystemPrompt(fullToolset());
  for (const tool of fullToolset()) {
    assert.ok(!prompt.includes(tool.description), `${tool.name}'s description is already sent in the tools array`);
  }
});

test("the system prompt only gives guidance for tools that exist", () => {
  const readOnly = buildSystemPrompt([readFileTool, searchCodeTool]);
  assert.ok(!readOnly.includes("edit_file"));
  assert.ok(!readOnly.includes("write_file"));
  assert.ok(!readOnly.includes("run_command"));
  assert.ok(readOnly.includes("search_code"));

  const full = buildSystemPrompt(fullToolset());
  for (const name of ["list_dir", "find_files", "search_code", "edit_file", "write_file", "run_command"]) {
    assert.ok(full.includes(name), `guidance for ${name} is missing`);
  }
});

test("the system prompt keeps its core rules", () => {
  const prompt = buildSystemPrompt(fullToolset());
  assert.match(prompt, /relative to the project root/i);
  assert.match(prompt, /before editing/i);
  assert.match(prompt, /placeholders/i);
  assert.match(prompt, /re-run/i);
});

test("every tool has a description and a well-formed parameter schema", () => {
  for (const tool of fullToolset()) {
    assert.ok(tool.description.trim().length > 10, `${tool.name} needs a description`);
    const schema = tool.parameters as { type?: string; properties?: Record<string, { type?: string }>; required?: string[] };
    assert.equal(schema.type, "object", tool.name);
    const props = schema.properties ?? {};
    for (const [name, prop] of Object.entries(props)) {
      assert.ok(["string", "integer", "boolean", "number"].includes(prop.type ?? ""), `${tool.name}.${name} needs a type`);
    }
    for (const required of schema.required ?? []) {
      assert.ok(required in props, `${tool.name} requires "${required}" but doesn't declare it`);
    }
  }
});

test("parameters whose meaning isn't obvious from their name stay documented", () => {
  const byName = new Map(fullToolset().map((t) => [t.name, t.parameters as { properties: Record<string, { description?: string }> }]));
  const mustExplain: [string, string][] = [
    ["edit_file", "target_content"],
    ["edit_file", "allow_multiple"],
    ["write_file", "overwrite"],
    ["run_command", "timeout_seconds"],
    ["search_code", "is_regex"],
    ["read_file", "start_line"],
  ];
  for (const [tool, param] of mustExplain) {
    const description = byName.get(tool)!.properties[param]?.description;
    assert.ok(description && description.length > 0, `${tool}.${param} should keep a description`);
  }
});
