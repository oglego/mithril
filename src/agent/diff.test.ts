import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLineDiff, formatUnifiedDiff, MAX_DIFF_LINES } from "./diff.js";

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

test("skips the expensive LCS diff for files over the line-count threshold", () => {
  // The old text is well past MAX_DIFF_LINES; computeLineDiff's O(n*m) cost
  // would be real at this size — formatUnifiedDiff should bail out before
  // ever calling it, not just produce a slow-but-correct result.
  const oldText = Array.from({ length: MAX_DIFF_LINES + 500 }, (_, i) => `line ${i}`).join("\n");
  const newText = "short file";

  const formatted = formatUnifiedDiff("huge.txt", oldText, newText);

  assert.match(formatted, /too large for a detailed diff/);
  assert.match(formatted, new RegExp(`${MAX_DIFF_LINES + 500}`));
});

test("still diffs normally for a file just under the threshold", () => {
  const oldText = Array.from({ length: MAX_DIFF_LINES - 1 }, (_, i) => `line ${i}`).join("\n");
  const newText = oldText + "\nnew line";

  const formatted = formatUnifiedDiff("ok.txt", oldText, newText);

  assert.doesNotMatch(formatted, /too large for a detailed diff/);
  assert.match(formatted, /\+ new line/);
});
