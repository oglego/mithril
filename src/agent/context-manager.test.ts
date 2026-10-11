import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ContextManager,
  TokenCalibrator,
  capToolResult,
  inputBudgetFor,
  formatCompactionReport,
  SUMMARY_HEADING,
} from "./context-manager.js";
import { estimateMessageTokens } from "./context.js";
import type { ApiToolDefinition, ChatMessage } from "../types.js";

const SYSTEM = "You are a test assistant.";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

function toolTurn(id: string, name: string, args: object, result: string): ChatMessage[] {
  return [
    { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: id, name, content: result },
  ];
}

function tokens(history: ChatMessage[]): number {
  return history.reduce((s, m) => s + estimateMessageTokens(m), 0);
}

// The message contract every request must satisfy, whatever compaction did.
function assertValid(history: ChatMessage[]): void {
  assert.equal(history[0]?.role, "system", "system prompt must stay first");
  assert.equal(history[1]?.role, "user", "conversation must open with a user message");
  const calls = new Set<string>();
  const answered = new Set<string>();
  for (const m of history) {
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) calls.add(c.id);
    if (m.role === "tool") {
      assert.ok(m.tool_call_id && calls.has(m.tool_call_id), "tool message without its assistant tool_call");
      answered.add(m.tool_call_id!);
    }
  }
  for (const id of calls) assert.ok(answered.has(id), `tool_call ${id} lost its response`);
}

function manager(maxInputTokens: number): ContextManager {
  return new ContextManager({ contextWindow: maxInputTokens * 2, maxInputTokens });
}

// Several finished exchanges, each with a big file read, plus a current task.
function longConversation(exchanges: number): ChatMessage[] {
  const h: ChatMessage[] = [{ role: "system", content: SYSTEM }];
  for (let i = 0; i < exchanges; i++) {
    h.push(user(`Please look at file number ${i}`));
    h.push(...toolTurn(`r${i}`, "read_file", { path: `src/file${i}.ts` }, "x".repeat(2000)));
    h.push(assistant(`File ${i} looks fine.`));
  }
  h.push(user("Now fix the bug in the parser"));
  return h;
}

// --- budgets ---

test("inputBudgetFor reserves 20% for the reply, clamped to 512..4096 tokens", () => {
  assert.equal(inputBudgetFor(8192), 8192 - 1638);
  assert.equal(inputBudgetFor(1024), 512);
  assert.equal(inputBudgetFor(100_000), 100_000 - 4096);
});

// --- no-op ---

test("leaves history untouched when it already fits", () => {
  const history = longConversation(1);
  const copy = structuredClone(history);
  const report = manager(100_000).prepare(history);
  assert.equal(report.changed, false);
  assert.equal(report.fits, true);
  assert.deepEqual(history, copy);
});

test("handles empty history", () => {
  assert.equal(manager(1000).prepare([]).changed, false);
});

// --- tier 1: stub old tool results ---

test("stubs old tool results before dropping anything", () => {
  const history = longConversation(3); // ~1.6k tokens
  const m = manager(1400);
  const report = m.prepare(history);
  assert.equal(report.fits, true);
  assert.ok(report.prunedResults > 0);
  assert.equal(report.droppedMessages, 0, "nothing should be condensed when stubbing is enough");
  const stub = history.find((x) => x.role === "tool" && x.content.startsWith("[Earlier "));
  assert.ok(stub, "an old result should have been replaced by a stub");
  assert.match(stub!.content, /read_file src\/file0\.ts/);
  assert.match(stub!.content, /Call the tool again/);
  assertValid(history);
});

test("does not stub the newest blocks in the first pass", () => {
  const history = longConversation(3);
  history.push(...toolTurn("fresh", "read_file", { path: "src/parser.ts" }, "y".repeat(2000)));
  manager(1900).prepare(history);
  const fresh = history.find((x) => x.role === "tool" && x.tool_call_id === "fresh")!;
  assert.equal(fresh.content, "y".repeat(2000));
});

test("prefers stubbing over condensing when stubbing is enough", () => {
  const history = longConversation(8);
  const report = manager(600).prepare(history);
  assert.equal(report.fits, true);
  assert.equal(report.droppedMessages, 0);
  assert.ok(!history[0]!.content.includes(SUMMARY_HEADING), "no summary should be written if nothing was dropped");
  assert.equal(history.filter((m) => m.role === "user").length, 9, "every user message is still present");
});

// --- tier 2: condense old exchanges ---

test("condenses old exchanges into a summary appended to the system prompt", () => {
  // ~4.2k tokens; stubbing every old result alone only gets to ~450, so a 400
  // budget forces whole exchanges to be condensed as well.
  const history = longConversation(8);
  const m = manager(400);
  const report = m.prepare(history);

  assert.equal(report.fits, true);
  assert.ok(report.droppedMessages > 0);
  assert.ok(tokens(history) <= 400);
  assertValid(history);

  assert.ok(history[0]!.content.startsWith(SYSTEM), "original system prompt must be preserved verbatim");
  assert.ok(history[0]!.content.includes(SUMMARY_HEADING));
  assert.match(history[0]!.content, /The user asked/);
  assert.match(history[0]!.content, /file number 0/);
  assert.match(history[0]!.content, /Files you read: .*src\/file0\.ts/);

  assert.equal(history[history.length - 1]!.content, "Now fix the bug in the parser");
});

test("never leaves the conversation opening with an assistant or tool message", () => {
  for (const budget of [300, 400, 450, 600, 900, 1200]) {
    const history = longConversation(8);
    manager(budget).prepare(history);
    assertValid(history);
  }
});

test("summary records modified files, command exit codes, and declined actions", () => {
  const h: ChatMessage[] = [{ role: "system", content: SYSTEM }];
  h.push(user("Add a feature"));
  h.push(...toolTurn("a", "edit_file", { path: "src/a.ts" }, 'Successfully updated "src/a.ts".'));
  h.push(...toolTurn("b", "edit_file", { path: "src/failed.ts" }, "Error editing file: no match"));
  h.push(...toolTurn("c", "write_file", { path: "src/declined.ts" }, "File write was declined by the user."));
  h.push(...toolTurn("d", "run_command", { command: "npm test" }, "[Exit code: 1 (900ms)]\n\nfail"));
  h.push(...toolTurn("e", "list_dir", {}, "z".repeat(3000)));
  h.push(assistant("Tests fail, investigating."));
  h.push(user("ok continue"));
  h.push(...toolTurn("f", "read_file", { path: "src/b.ts" }, "w".repeat(3000)));

  manager(350).prepare(h);
  const sysText = h[0]!.content;
  assert.match(sysText, /Files you modified: src\/a\.ts/);
  assert.ok(!sysText.includes("src/failed.ts"), "a failed edit is not a modification");
  assert.ok(!sysText.includes("src/declined.ts"));
  assert.match(sysText, /`npm test` \(exit 1\)/);
  assert.match(sysText, /Actions the user declined: 1/);
  assert.match(sysText, /list_dir×1/);
  assert.match(sysText, /Tests fail, investigating/);
});

test("the summary accumulates across compactions without duplicating itself", () => {
  const m = manager(400);
  const history = longConversation(12); // too long for stubbing alone at this budget
  m.prepare(history);
  assert.match(history[0]!.content, /Please look at file number/);

  // The conversation continues and overflows again.
  for (let i = 10; i < 16; i++) {
    history.push(assistant("done"));
    history.push(user(`Look at file number ${i}`));
    history.push(...toolTurn(`n${i}`, "read_file", { path: `src/new${i}.ts` }, "q".repeat(2000)));
  }
  m.prepare(history);

  const sysText = history[0]!.content;
  assert.equal(sysText.split(SUMMARY_HEADING).length - 1, 1, "exactly one summary section");
  // Entries are kept newest-first within the summary's size cap, so the very
  // oldest may roll off, but both compactions must be represented.
  assert.match(sysText, /Please look at file number/, "facts from the first compaction must survive the second");
  assert.match(sysText, /"Look at file number 1\d"/, "facts from the second compaction must be added");
  assertValid(history);
});

test("the summary stays small however much is dropped", () => {
  const history = longConversation(200);
  const m = manager(800);
  m.prepare(history);
  const summaryChars = history[0]!.content.length - SYSTEM.length;
  assert.ok(summaryChars <= 600 + SUMMARY_HEADING.length + 10, `summary was ${summaryChars} chars`);
  assert.ok(tokens(history) <= 800);
});

// --- inside the current task ---

test("a single long task: older steps are condensed, the user request and newest step survive", () => {
  const h: ChatMessage[] = [{ role: "system", content: SYSTEM }, user("Refactor the whole module")];
  for (let i = 0; i < 12; i++) h.push(...toolTurn(`s${i}`, "read_file", { path: `src/m${i}.ts` }, "k".repeat(1800)));

  const m = manager(900);
  const report = m.prepare(h);
  assert.equal(report.fits, true);
  assert.ok(tokens(h) <= 900);
  assertValid(h);
  assert.equal(h[1]!.content, "Refactor the whole module");
  const lastTool = h[h.length - 1]!;
  assert.equal(lastTool.tool_call_id, "s11", "the newest step must be kept");
});

test("truncates the newest tool result as a last resort", () => {
  const h: ChatMessage[] = [{ role: "system", content: SYSTEM }, user("Read it"), ...toolTurn("big", "read_file", { path: "a.ts" }, "m".repeat(8000))];
  const report = manager(700).prepare(h);
  assert.equal(report.fits, true);
  const tool = h[h.length - 1]!;
  assert.match(tool.content, /characters omitted/);
  assert.ok(tokens(h) <= 700);
});

test("reports fits=false when even the pinned user message cannot fit", () => {
  const h: ChatMessage[] = [{ role: "system", content: SYSTEM }, user("w".repeat(20_000))];
  const report = manager(500).prepare(h);
  assert.equal(report.fits, false);
  assert.equal(h[1]!.content.length, 20_000, "the user's message is never altered");
});

test("is idempotent: a second prepare on compacted history changes nothing", () => {
  const history = longConversation(8);
  const m = manager(400);
  m.prepare(history);
  const snapshot = structuredClone(history);
  const second = m.prepare(history);
  assert.equal(second.changed, false);
  assert.deepEqual(history, snapshot);
});

test("tool definitions count against the budget", () => {
  const history = longConversation(1);
  const defs: ApiToolDefinition[] = [
    { type: "function", function: { name: "big_tool", description: "d".repeat(6000), parameters: {} } },
  ];
  const m = manager(tokens(history) + 200);
  assert.equal(m.prepare(structuredClone(history)).changed, false);
  const withDefs = m.prepare(structuredClone(history), defs);
  assert.equal(withDefs.changed, true, "~1500 tokens of tool schema must force compaction");
});

test("starting a new conversation (different system prompt) resets the summary", () => {
  const m = manager(400);
  const a = longConversation(8);
  m.prepare(a);
  assert.match(a[0]!.content, /file number 0/);

  const b = longConversation(8);
  b[0] = { role: "system", content: "A completely different system prompt." };
  for (const msg of b) if (msg.role === "user") msg.content = msg.content.replace("file number", "doc number");
  m.prepare(b);
  assert.ok(!b[0]!.content.includes("file number"), "stale facts must not leak into a new conversation");
  assert.match(b[0]!.content, /doc number/);
});

// --- calibration ---

test("TokenCalibrator learns the ratio, smooths it, and clamps outliers", () => {
  const c = new TokenCalibrator();
  assert.equal(c.apply(100), 100);
  c.observe(100, 150);
  assert.equal(c.factor, 1.5);
  c.observe(100, 100); // ratio 1.0 -> halfway between
  assert.equal(c.factor, 1.25);
  c.observe(100, 100_000); // absurd -> clamped to 4
  assert.ok(c.factor <= 0.5 * 1.25 + 0.5 * 4 + 1e-9);
  const low = new TokenCalibrator();
  low.observe(100, 1);
  assert.equal(low.factor, 0.5);
});

test("TokenCalibrator ignores unusable readings", () => {
  const c = new TokenCalibrator();
  c.observe(0, 100);
  c.observe(100, 0);
  c.observe(100, NaN);
  assert.equal(c.samples, 0);
  assert.equal(c.factor, 1);
});

test("learned calibration makes the manager compact earlier", () => {
  const history = longConversation(2);
  const budget = tokens(history) + 100;
  const m = manager(budget);
  assert.equal(m.prepare(structuredClone(history)).changed, false);
  m.prepare(structuredClone(history)); // sets the raw estimate for this prompt
  m.observeUsage(Math.ceil(tokens(history) * 2)); // server says: twice as many tokens as you think
  assert.ok(m.calibrator.factor > 1.5);
  assert.equal(m.prepare(structuredClone(history)).changed, true);
});

// --- capToolResult ---

test("capToolResult keeps short text and cuts the middle of long text", () => {
  assert.equal(capToolResult("short", 100), "short");
  const text = "HEAD" + "m".repeat(5000) + "TAIL";
  const capped = capToolResult(text, 500);
  assert.ok(capped.length <= 500);
  assert.ok(capped.startsWith("HEAD"));
  assert.ok(capped.endsWith("TAIL"));
  assert.match(capped, /characters omitted/);
});

// --- reporting ---

test("describe and formatCompactionReport produce readable text", () => {
  const history = longConversation(8);
  const m = manager(400);
  const report = m.prepare(history);
  const text = m.describe(history);
  assert.match(text, /Context window: 800 tokens/);
  assert.match(text, /Compactions this session: 1/);
  assert.match(formatCompactionReport(report), /Context compacted: .*trimmed|condensed/);
});

test("reports unavoidable overhead and suggests a workable window", async () => {
  const { suggestedWindowFor } = await import("./context-manager.js");
  const h: ChatMessage[] = [{ role: "system", content: "S".repeat(4000) }, user("hi")]; // ~1000 tokens fixed
  const m = manager(2000);
  const report = m.prepare(h);
  assert.ok(report.fixedTokens >= 1000 && report.fixedTokens < 1100, `fixed=${report.fixedTokens}`);
  assert.equal(m.fixedPromptTokens(h), report.fixedTokens);
  const suggested = suggestedWindowFor(report.fixedTokens);
  assert.equal(suggested % 256, 0);
  assert.ok(suggested * 0.8 >= report.fixedTokens + 1500, "suggestion must leave ~1500 tokens for conversation");
});

test("fixed overhead excludes the summary, so it doesn't grow as history is condensed", () => {
  const history = longConversation(12);
  const m = manager(400);
  const before = m.fixedPromptTokens(history);
  m.prepare(history);
  assert.equal(m.fixedPromptTokens(history), before);
});
