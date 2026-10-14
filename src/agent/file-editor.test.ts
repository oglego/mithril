import { readFileSync } from "node:fs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyReplacement } from "./file-editor.js";
import { createEditFileTool } from "./tools.js";

const FILE = ["function a() {", "  return 1;", "}", "", "function b() {", "  return 2;", "}", ""].join("\n");

// ---- successful edits still work ----

test("an exact, unique match is replaced", () => {
  const r = applyReplacement(FILE, "return 2;", "return 3;");
  assert.equal(r.success, true);
  assert.equal(r.matchType, "exact");
  assert.ok(r.content!.includes("return 3;") && !r.content!.includes("return 2;"));
});

test("a match that differs only in indentation is still found", () => {
  const r = applyReplacement(FILE, "return 1;", "return 9;");
  assert.equal(r.success, true);
  const tolerant = applyReplacement(FILE, "function a() {\nreturn 1;\n}", "function a() {\n  return 7;\n}");
  assert.equal(tolerant.success, true);
  assert.equal(tolerant.matchType, "whitespace_normalized");
});

test("allow_multiple replaces every occurrence", () => {
  const r = applyReplacement("x x x", "x", "y", true);
  assert.deepEqual([r.success, r.content], [true, "y y y"]);
});

// ---- every error says what to do next ----

test("an empty target points to the right tools", () => {
  const r = applyReplacement(FILE, "", "x");
  assert.equal(r.success, false);
  assert.match(r.error!, /short snippet of the text currently in the file/);
  assert.match(r.error!, /write_file/);
});

test("a target that appears several times offers both ways out", () => {
  const r = applyReplacement("x x x", "x", "y");
  assert.equal(r.success, false);
  assert.match(r.error!, /found 3 times/);
  assert.match(r.error!, /surrounding lines/);
  assert.match(r.error!, /allow_multiple=true/);
});

test("indentation-insensitive ambiguity says how many places matched", () => {
  // No exact match ("a\nb" is not verbatim in the file), but two places match once indentation is ignored.
  const r = applyReplacement("  a\n  b\n    a\n    b\n", "a\nb", "c");
  assert.equal(r.success, false);
  assert.match(r.error!, /matched 2 places even when ignoring indentation/);
});

test("'not found' says the target must already be in the file and where the new text goes", () => {
  const r = applyReplacement(FILE, "return 99;", "return 100;");
  assert.equal(r.success, false);
  assert.match(r.error!, /was not found in the file/);
  assert.match(r.error!, /already in the file/);
  assert.match(r.error!, /copied exactly from read_file/);
  assert.match(r.error!, /new text belongs in replacement_content/);
  assert.match(r.error!, /write_file with overwrite=true/);
});

test("a target longer than the file reports both sizes and says it must be a snippet", () => {
  const r = applyReplacement("one\ntwo\n", "a\nb\nc\nd\ne\n", "x");
  assert.equal(r.success, false);
  assert.match(r.error!, /target_content has 6 lines but the whole file has only 3/);
  assert.match(r.error!, /short snippet of the text that is currently in the file, not the new version/);
  assert.match(r.error!, /replacement_content/);
  assert.match(r.error!, /write_file with overwrite=true/);
});

// ---- the confusion seen in real runs ----

test("swapped fields are detected when the replacement text already exists in the file", () => {
  // The model put the NEW text in target_content and the OLD text in replacement_content.
  const r = applyReplacement(FILE, "return 20;", "return 2;");
  assert.equal(r.success, false);
  assert.match(r.error!, /replacement_content IS present in the file/);
  assert.match(r.error!, /swapped/);
  assert.match(r.error!, /target_content is the OLD text/);
});

test("no swap hint when the replacement is not in the file", () => {
  const r = applyReplacement(FILE, "return 99;", "return 100;");
  assert.doesNotMatch(r.error!, /swapped/);
});

test("an empty replacement (a deletion request) never triggers the swap hint", () => {
  const r = applyReplacement(FILE, "not in the file", "");
  assert.equal(r.success, false);
  assert.doesNotMatch(r.error!, /swapped/);
});

test("identical target and replacement is an error, not a silent no-op", () => {
  const found = applyReplacement(FILE, "return 2;", "return 2;");
  assert.equal(found.success, false);
  assert.match(found.error!, /identical, so nothing would change/);
  assert.match(found.error!, /replacement_content is the NEW text/);
  const missing = applyReplacement(FILE, "return 42;", "return 42;");
  assert.equal(missing.success, false);
  assert.match(missing.error!, /identical/);
});

test("putting the whole new file in target_content (as a 2B model did) gets actionable advice", () => {
  const json = readFileSync(fileURLToPath(new URL("../../eval-tasks/edit-json-config/fixture/config.json", import.meta.url)), "utf-8");
  const newVersion = json.replace("8080", "9090").replace('"info"', '"debug"');
  const r = applyReplacement(json, newVersion, newVersion);
  assert.equal(r.success, false);
  const different = applyReplacement(json, newVersion, json);
  assert.equal(different.success, false);
  assert.match(different.error!, /not found|more lines/);
  assert.match(different.error!, /replacement_content/);
  assert.match(different.error!, /write_file with overwrite=true/);
  assert.match(different.error!, /swapped/, "here the OLD text really is in replacement_content");
});

// ---- through the real tool ----

const scratch: string[] = [];
after(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

test("edit_file returns these messages to the model, and leaves the file alone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mithril-edit-"));
  scratch.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.js"), FILE);
  const previous = process.env.MITHRIL_PROJECT_ROOT;
  process.env.MITHRIL_PROJECT_ROOT = root;
  try {
    const tool = createEditFileTool({ confirm: async () => true });
    const result = await tool.execute({ path: "src/a.js", target_content: "return 99;", replacement_content: "return 100;" });
    assert.match(result, /^Error editing file: target_content was not found in the file/);
    assert.match(result, /write_file with overwrite=true/);
    assert.equal(await readFile(path.join(root, "src", "a.js"), "utf-8"), FILE, "a failed edit must not change the file");

    const ok = await tool.execute({ path: "src/a.js", target_content: "return 2;", replacement_content: "return 3;" });
    assert.doesNotMatch(ok, /^Error/);
    assert.match(await readFile(path.join(root, "src", "a.js"), "utf-8"), /return 3;/);
  } finally {
    if (previous === undefined) delete process.env.MITHRIL_PROJECT_ROOT;
    else process.env.MITHRIL_PROJECT_ROOT = previous;
  }
});
