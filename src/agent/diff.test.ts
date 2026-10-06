import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLineDiff, formatUnifiedDiff } from "./diff.js";

test("computes line additions and removals", () => {
  const oldText = "line 1\nline 2\nline 3";
  const newText = "line 1\nline 2 modified\nline 3\nline 4";

  const diff = computeLineDiff(oldText, newText);

  const removes = diff.filter((d) => d.type === "remove");
  const adds = diff.filter((d) => d.type === "add");
  const keeps = diff.filter((d) => d.type === "keep");

  assert.equal(removes.length, 1);
  assert.equal(removes[0]?.text, "line 2");

  assert.equal(adds.length, 2);
  assert.equal(adds[0]?.text, "line 2 modified");
  assert.equal(adds[1]?.text, "line 4");

  assert.equal(keeps.length, 2);
});

test("returns (No changes) when texts are identical", () => {
  const text = "constant\ncode";
  const formatted = formatUnifiedDiff("test.txt", text, text);
  assert.equal(formatted, "(No changes)");
});

test("formats unified diff with +/- lines and header", () => {
  const oldText = "const a = 1;\nconst b = 2;";
  const newText = "const a = 1;\nconst b = 3;";

  const formatted = formatUnifiedDiff("index.ts", oldText, newText);

  assert.match(formatted, /--- a\/index\.ts/);
  assert.match(formatted, /\+\+\+ b\/index\.ts/);
  assert.match(formatted, /- const b = 2;/);
  assert.match(formatted, /\+ const b = 3;/);
});
