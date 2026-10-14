import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeclinedResult } from "./tool-results.js";

test("recognises every kind of refusal the tools can produce", () => {
  assert.equal(isDeclinedResult("write_file", "File write was declined by the user."), true);
  assert.equal(isDeclinedResult("edit_file", "File edit was declined by the user."), true);
  assert.equal(isDeclinedResult("run_command", "Command execution was declined by the user."), true);
  assert.equal(isDeclinedResult("run_command", "Command was declined: you are already in the project directory."), true);
});

test("ordinary content that merely contains the phrase is not a refusal", () => {
  const source = 'return "Command execution was declined by the user.";';
  for (const tool of ["read_file", "search_code", "list_dir", "find_files"]) {
    assert.equal(isDeclinedResult(tool, source), false, `${tool} output is content, never a refusal`);
  }
});

test("the output of a command that really ran is never a refusal", () => {
  assert.equal(isDeclinedResult("run_command", "[Exit code: 0 (12ms)]\n\nrequest was declined by the user"), false);
  assert.equal(isDeclinedResult("run_command", "[Exit code: 1 (5ms)]\n\nError: declined"), false);
});

test("only the first line counts, for tools that can be refused", () => {
  assert.equal(isDeclinedResult("write_file", "Successfully wrote x.\nNote: the other write was declined by the user."), false);
});

test("a word that only contains 'declined' does not match", () => {
  assert.equal(isDeclinedResult("edit_file", "Error: undeclined variable"), false);
});
