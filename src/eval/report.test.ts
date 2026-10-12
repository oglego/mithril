import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { summarizeReport, formatSummary, formatComparison, writeReport, loadReport, ReportError } from "./report.js";
import { emptyMetrics } from "./runner.js";
import type { EvalReport, FailureKind, RunResult } from "./types.js";

const scratch: string[] = [];
after(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

function run(task: string, n: number, passed: boolean, over: Partial<RunResult> & { malformed?: number; failed?: number; peak?: number | null } = {}): RunResult {
  const metrics = emptyMetrics();
  metrics.modelCalls = 4;
  metrics.toolCalls = 6;
  metrics.outcomes.ok = 6 - (over.malformed ?? 0) - (over.failed ?? 0);
  metrics.outcomes.bad_arguments = over.malformed ?? 0;
  metrics.outcomes.tool_error = over.failed ?? 0;
  metrics.peakPromptTokens = over.peak === undefined ? 2500 : over.peak;
  return {
    task, run: n, passed, stopReason: "answered", durationMs: 2000, changedFiles: ["a.txt"], reply: "done", metrics,
    check: { passed, exitCode: passed ? 0 : 1, timedOut: false, output: passed ? "" : "FAIL: expected 1 but got 2" },
    ...(passed ? {} : { failureKind: (over.failureKind ?? "check_failed") as FailureKind }),
  };
}

function report(label: string, passesByTask: Record<string, [number, number]>, over: Partial<EvalReport> = {}): EvalReport {
  return {
    schemaVersion: 1, label, startedAt: "2026-01-02T03:04:05.678Z", finishedAt: "2026-01-02T03:10:00.000Z", node: "v22.0.0",
    backend: { baseUrl: "http://x", model: "test-model" }, contextWindow: { window: 8192, source: "default" },
    temperature: null, runsPerTask: 3, fixedOverheadTokens: 829, promptFingerprint: "abcd1234",
    tasks: Object.entries(passesByTask).map(([id, [k, n]]) => ({
      id, title: `Task ${id}`, type: "edit" as const, runs: Array.from({ length: n }, (_, i) => run(id, i + 1, i < k)),
    })),
    ...over,
  };
}

test("summarizeReport counts passes, malformed calls and tool failures separately", () => {
  const r = report("x", {});
  r.tasks = [{
    id: "t", title: "T", type: "edit",
    runs: [run("t", 1, true, { malformed: 1 }), run("t", 2, false, { failed: 2, failureKind: "max_steps" }), run("t", 3, true, { peak: 4000 })],
  }];
  const { tasks, overall } = summarizeReport(r);
  assert.equal(tasks[0]!.passes, 2);
  assert.equal(tasks[0]!.malformed, 1);
  assert.equal(tasks[0]!.failed, 2);
  assert.equal(tasks[0]!.peakPromptTokens, 4000);
  assert.equal(tasks[0]!.meanSteps, 4);
  assert.deepEqual(overall.failureKinds, { max_steps: 1 });
  assert.equal(overall.toolCalls, 18);
  assert.equal(overall.runs, 3);
});

test("summaries cope with servers that report no token usage", () => {
  const r = report("x", {});
  r.tasks = [{ id: "t", title: "T", type: "edit", runs: [run("t", 1, true, { peak: null })] }];
  assert.equal(summarizeReport(r).tasks[0]!.peakPromptTokens, null);
  assert.match(formatSummary(r), /n\/a/);
});

test("formatSummary shows the table, the interval, the failure reasons and the failures", () => {
  const text = formatSummary(report("lean prompt", { "fix-bug": [3, 3], "rename-it": [1, 3] }));
  assert.match(text, /Model: test-model/);
  assert.match(text, /Fixed prompt overhead: ~829 tokens/);
  assert.match(text, /Prompt fingerprint: abcd1234/);
  assert.match(text, /Label: lean prompt/);
  assert.match(text, /fix-bug\s+3\/3/);
  assert.match(text, /rename-it\s+1\/3/);
  assert.match(text, /Overall: 4\/6 passed \(67%, 95% interval \d+% to \d+%\)/);
  assert.match(text, /Why runs failed: check_failed ×2/);
  assert.match(text, /x rename-it \(run 2\): check_failed - expected 1 but got 2/);
});

test("formatSummary caps a long failure list", () => {
  const text = formatSummary(report("x", { t: [0, 20] }));
  assert.match(text, /and 5 more/);
});

test("results files round-trip, and the file name carries the time and a slug of the label", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mithril-report-"));
  scratch.push(dir);
  const r = report("Lean Prompt #2!", { a: [2, 3] });
  const file = await writeReport(r, path.join(dir, "nested", "out"));
  assert.match(path.basename(file), /^2026-01-02T03-04-05-678Z-lean-prompt-2\.json$/);
  assert.deepEqual(await loadReport(file), JSON.parse(await readFile(file, "utf-8")));
  assert.equal((await loadReport(file)).tasks[0]!.runs.length, 3);
});

test("loadReport rejects unreadable and foreign files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mithril-report-"));
  scratch.push(dir);
  await assert.rejects(() => loadReport(path.join(dir, "missing.json")), ReportError);
  const bad = path.join(dir, "bad.json");
  await writeFile(bad, JSON.stringify({ hello: "world" }));
  await assert.rejects(() => loadReport(bad), /not an eval results file/);
  await writeFile(bad, "not json");
  await assert.rejects(() => loadReport(bad), ReportError);
});

test("comparison calls a small difference within noise", () => {
  const text = formatComparison(report("before", { a: [2, 3], b: [2, 3], c: [1, 3] }), report("after", { a: [3, 3], b: [2, 3], c: [2, 3] }));
  assert.match(text, /A: before/);
  assert.match(text, /B: after/);
  assert.match(text, /a\s+2\/3\s+3\/3\s+\+33 points/);
  assert.match(text, /b\s+2\/3\s+2\/3\s+same/);
  assert.match(text, /Verdict: within noise/);
  assert.match(text, /anecdotes/);
});

test("comparison declares a winner only when the intervals do not overlap", () => {
  const strong = report("strong", { a: [30, 30] });
  const weak = report("weak", { a: [3, 30] });
  assert.match(formatComparison(weak, strong), /Verdict: B is better/);
  assert.match(formatComparison(strong, weak), /Verdict: A is better/);
});

test("comparison notes whether the model and prompt are the same", () => {
  const a = report("a", { t: [1, 1] });
  assert.match(formatComparison(a, report("b", { t: [1, 1] })), /Same model and same prompt\+tools/);
  assert.match(formatComparison(a, report("b", { t: [1, 1] }, { promptFingerprint: "ffff0000" })), /Same model, different prompt or tools/);
  const other = report("b", { t: [1, 1] }, { backend: { baseUrl: "http://x", model: "other-model" } });
  const text = formatComparison(a, other);
  assert.ok(!/Same model/.test(text));
});

test("comparison lists tasks present on only one side", () => {
  const text = formatComparison(report("a", { shared: [1, 1], onlya: [1, 1] }), report("b", { shared: [1, 1], onlyb: [1, 1] }));
  assert.match(text, /Only in A: onlya/);
  assert.match(text, /Only in B: onlyb/);
});
