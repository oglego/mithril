import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamPrinter, looksLikeToolCall } from "./stream-printer.js";

function run(tokens: string[]): { written: string; result: { text: string; shown: boolean } } {
  let written = "";
  const printer = createStreamPrinter((t) => (written += t));
  for (const t of tokens) printer.push(t);
  const result = printer.finish(); // flushes anything still held back
  return { written, result };
}

test("a normal answer is shown in full, token by token after the hold-back", () => {
  const writes: string[] = [];
  const printer = createStreamPrinter((t) => writes.push(t));
  const tokens = ["The ", "function ", "returns ", "the ", "sum ", "of ", "both ", "arguments."];
  for (const t of tokens) printer.push(t);
  const result = printer.finish();
  assert.equal(writes.join(""), tokens.join(""));
  assert.ok(writes.length > 1, "later tokens should stream through individually");
  assert.deepEqual(result, { text: tokens.join(""), shown: true });
});

test("a short reply is shown when the response ends", () => {
  const { written, result } = run(["Hi", "!"]);
  assert.equal(written, "Hi!");
  assert.equal(result.shown, true);
});

test("raw tool-call text is suppressed, but still reported in `text`", () => {
  const { written, result } = run(["<tool_call>", '{"name":"read_file",', '"arguments":{}}', "</tool_call>"]);
  assert.equal(written, "");
  assert.equal(result.shown, false);
  assert.ok(result.text.startsWith("<tool_call>"));
});

test("a bare JSON tool call is suppressed", () => {
  const { written } = run(['{"name": "read_file", ', '"arguments": {"path": "a.ts"}}']);
  assert.equal(written, "");
});

test("ordinary text that merely starts with a brace is not suppressed", () => {
  const { written } = run(["{ this is a set literal and not a tool call at all }"]);
  assert.ok(written.length > 0);
});

test("leading whitespace doesn't fool the check", () => {
  assert.equal(looksLikeToolCall("\n  <tool_call>"), true);
  assert.equal(looksLikeToolCall("  Sure, here you go"), false);
});

test("the printer resets between model responses", () => {
  let written = "";
  const printer = createStreamPrinter((t) => (written += t));
  printer.push("<tool_call>{}</tool_call> and a long tail of suppressed text");
  assert.equal(printer.finish().shown, false);
  printer.push("Second response is a normal, visible answer.");
  assert.equal(printer.finish().shown, true);
  assert.equal(written, "Second response is a normal, visible answer.");
});

test("an empty response reports nothing shown", () => {
  const { written, result } = run([]);
  assert.equal(written, "");
  assert.deepEqual(result, { text: "", shown: false });
});
