import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { intervalsOverlap, mean, wilsonInterval } from "./stats.js";
import type { EvalReport, RunResult } from "./types.js";

export class ReportError extends Error {}

export interface TaskSummary {
  id: string;
  title: string;
  runs: number;
  passes: number;
  meanSteps: number | null;
  meanDurationMs: number | null;
  peakPromptTokens: number | null;
  toolCalls: number;
  malformed: number; // unknown tool + unparseable arguments: the model's mistakes
  failed: number; // tools that ran and reported an error, or threw
  declined: number;
  failureKinds: Record<string, number>;
}

export interface OverallSummary {
  runs: number;
  passes: number;
  interval: { low: number; high: number };
  toolCalls: number;
  malformed: number;
  failed: number;
  declined: number;
  completionTokens: number | null;
  totalDurationMs: number;
  failureKinds: Record<string, number>;
}

function countKinds(runs: RunResult[]): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const r of runs) if (r.failureKind) kinds[r.failureKind] = (kinds[r.failureKind] ?? 0) + 1;
  return kinds;
}

function sumOutcomes(runs: RunResult[]) {
  let toolCalls = 0, malformed = 0, failed = 0, declined = 0;
  for (const r of runs) {
    toolCalls += r.metrics.toolCalls;
    malformed += r.metrics.outcomes.unknown_tool + r.metrics.outcomes.bad_arguments;
    failed += r.metrics.outcomes.tool_error + r.metrics.outcomes.tool_exception;
    declined += r.metrics.outcomes.declined;
  }
  return { toolCalls, malformed, failed, declined };
}

export function summarizeReport(report: EvalReport): { tasks: TaskSummary[]; overall: OverallSummary } {
  const tasks: TaskSummary[] = report.tasks.map((t) => {
    const peaks = t.runs.map((r) => r.metrics.peakPromptTokens).filter((v): v is number => v !== null);
    return {
      id: t.id,
      title: t.title,
      runs: t.runs.length,
      passes: t.runs.filter((r) => r.passed).length,
      meanSteps: mean(t.runs.map((r) => r.metrics.modelCalls)),
      meanDurationMs: mean(t.runs.map((r) => r.durationMs)),
      peakPromptTokens: peaks.length ? Math.max(...peaks) : null,
      ...sumOutcomes(t.runs),
      failureKinds: countKinds(t.runs),
    };
  });
  const all = report.tasks.flatMap((t) => t.runs);
  const completion = all.map((r) => r.metrics.completionTokens).filter((v): v is number => v !== null);
  const passes = all.filter((r) => r.passed).length;
  return {
    tasks,
    overall: {
      runs: all.length,
      passes,
      interval: wilsonInterval(passes, all.length),
      ...sumOutcomes(all),
      completionTokens: completion.length ? completion.reduce((s, v) => s + v, 0) : null,
      totalDurationMs: all.reduce((s, r) => s + r.durationMs, 0),
      failureKinds: countKinds(all),
    },
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const tokensLabel = (n: number | null) => (n === null ? "n/a" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const secs = (ms: number | null) => (ms === null ? "n/a" : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`);
const fixed1 = (n: number | null) => (n === null ? "n/a" : n.toFixed(1));

export function formatSummary(report: EvalReport): string {
  const { tasks, overall } = summarizeReport(report);
  const idWidth = Math.max(4, ...tasks.map((t) => t.id.length));
  const row = (cols: string[]) =>
    cols[0]!.padEnd(idWidth) + "  " + cols.slice(1).map((c, i) => (i === 0 ? c.padEnd(6) : c.padEnd(10))).join("");

  const completed = tasks.reduce((n, t) => n + t.runs, 0);
  const lines: string[] = [
    ...(report.partial
      ? [`PARTIAL RESULTS: ${completed} of ${report.plannedRuns ?? "?"} planned runs completed. Do not compare these with a finished run.`, ""]
      : []),
    `Model: ${report.backend.model}   Context window: ${report.contextWindow.window.toLocaleString("en-US")} (${report.contextWindow.source})` +
      `   Runs per task: ${report.runsPerTask}` +
      (report.temperature !== null ? `   Temperature: ${report.temperature}` : ""),
    `Fixed prompt overhead: ~${report.fixedOverheadTokens} tokens   Prompt fingerprint: ${report.promptFingerprint}` +
      (report.label ? `   Label: ${report.label}` : ""),
    "",
    row(["task", "pass", "steps", "malformed", "failed", "peak prompt", "time"]),
  ];
  for (const t of tasks) {
    lines.push(
      row([t.id, `${t.passes}/${t.runs}`, fixed1(t.meanSteps), String(t.malformed), String(t.failed), tokensLabel(t.peakPromptTokens), secs(t.meanDurationMs)])
    );
  }

  lines.push("", `Overall: ${overall.passes}/${overall.runs} passed (${pct(overall.passes / Math.max(1, overall.runs))}, 95% interval ${pct(overall.interval.low)} to ${pct(overall.interval.high)})`);
  const rate = (n: number) => (overall.toolCalls ? ` (${((n / overall.toolCalls) * 100).toFixed(1)}%)` : "");
  lines.push(
    `Tool calls: ${overall.toolCalls}: ${overall.malformed} malformed${rate(overall.malformed)}, ${overall.failed} failed${rate(overall.failed)}, ${overall.declined} declined`
  );
  const kinds = Object.entries(overall.failureKinds).sort((a, b) => b[1] - a[1]);
  if (kinds.length) lines.push(`Why runs failed: ${kinds.map(([k, n]) => `${k} ×${n}`).join(", ")}`);
  lines.push(`Total time: ${secs(overall.totalDurationMs)}   Completion tokens: ${tokensLabel(overall.completionTokens)}`);

  const failures = report.tasks.flatMap((t) => t.runs.filter((r) => !r.passed));
  if (failures.length) {
    lines.push("", "Failures:");
    for (const r of failures.slice(0, 15)) {
      const detail = (r.check.output.replace(/^FAIL:\s*/, "").split("\n")[0] || r.reply.split("\n")[0] || "").slice(0, 110);
      lines.push(`  x ${r.task} (run ${r.run}): ${r.failureKind}${detail ? ` - ${detail}` : ""}`);
    }
    if (failures.length > 15) lines.push(`  ... and ${failures.length - 15} more (see the results file)`);
  }
  return lines.join("\n");
}

// The file a run's results go to. Derived from the start time and label only,
// so the same path is used every time the run saves.
export function reportFilePath(outDir: string, startedAt: string, label: string): string {
  const stamp = startedAt.replace(/[:.]/g, "-");
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return path.join(outDir, `${stamp}${slug ? `-${slug}` : ""}.json`);
}

// Written to a temporary file and renamed into place, so a crash or kill in
// the middle of a save can never leave a truncated results file behind.
export async function writeReport(report: EvalReport, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const file = reportFilePath(outDir, report.startedAt, report.label);
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(report, null, 2), "utf-8");
  await rename(temp, file);
  return file;
}

export async function loadReport(file: string): Promise<EvalReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf-8"));
  } catch (err) {
    throw new ReportError(`Cannot read results file "${file}": ${(err as Error).message}`);
  }
  const r = parsed as Partial<EvalReport> | null;
  if (!r || r.schemaVersion !== 1 || !Array.isArray(r.tasks)) {
    throw new ReportError(`"${file}" is not an eval results file (expected schemaVersion 1).`);
  }
  return r as EvalReport;
}

export function formatComparison(a: EvalReport, b: EvalReport): string {
  const sa = summarizeReport(a);
  const sb = summarizeReport(b);
  const describe = (name: string, r: EvalReport) =>
    `  ${name}: ${r.label || "(no label)"}  model=${r.backend.model}  ctx=${r.contextWindow.window}  overhead=~${r.fixedOverheadTokens}  prompt=${r.promptFingerprint}`;
  const lines = ["Comparing results", describe("A", a), describe("B", b), ""];

  const byIdB = new Map(sb.tasks.map((t) => [t.id, t]));
  const idWidth = Math.max(4, ...sa.tasks.map((t) => t.id.length));
  lines.push("task".padEnd(idWidth) + "  " + "A".padEnd(8) + "B".padEnd(8) + "change");
  const onlyA: string[] = [];
  for (const ta of sa.tasks) {
    const tb = byIdB.get(ta.id);
    if (!tb) {
      onlyA.push(ta.id);
      continue;
    }
    const delta = Math.round((tb.passes / Math.max(1, tb.runs) - ta.passes / Math.max(1, ta.runs)) * 100);
    lines.push(
      ta.id.padEnd(idWidth) + "  " + `${ta.passes}/${ta.runs}`.padEnd(8) + `${tb.passes}/${tb.runs}`.padEnd(8) + (delta === 0 ? "same" : `${delta > 0 ? "+" : ""}${delta} points`)
    );
    byIdB.delete(ta.id);
  }
  if (onlyA.length) lines.push(`Only in A: ${onlyA.join(", ")}`);
  if (byIdB.size) lines.push(`Only in B: ${[...byIdB.keys()].join(", ")}`);

  const oa = sa.overall, ob = sb.overall;
  const rateA = oa.passes / Math.max(1, oa.runs), rateB = ob.passes / Math.max(1, ob.runs);
  const versionA = a.harnessVersion ?? 1, versionB = b.harnessVersion ?? 1;
  if (versionA !== versionB) {
    lines.push(
      `Warning: A used harness version ${versionA} and B used ${versionB}. The environment the model worked in differed ` +
        `(see src/eval/version.ts), so any difference mixes the effect of that with everything else you changed.`
    );
  }
  for (const [name, r] of [["A", a], ["B", b]] as const) {
    if (r.partial) lines.push(`Warning: ${name} is a partial result (the run did not finish), so its numbers are incomplete.`);
  }
  lines.push(
    "",
    `Overall A: ${oa.passes}/${oa.runs} (${pct(rateA)}, ${pct(oa.interval.low)} to ${pct(oa.interval.high)})`,
    `Overall B: ${ob.passes}/${ob.runs} (${pct(rateB)}, ${pct(ob.interval.low)} to ${pct(ob.interval.high)})`
  );

  if (a.promptFingerprint === b.promptFingerprint && a.backend.model === b.backend.model) {
    lines.push("Same model and same prompt+tools: any difference is run-to-run variation or settings.");
  } else if (a.backend.model === b.backend.model) {
    lines.push("Same model, different prompt or tools.");
  }

  if (intervalsOverlap(oa.interval, ob.interval)) {
    lines.push(
      `Verdict: within noise. The 95% intervals overlap, so this sample cannot tell A and B apart. ` +
        `Run more tasks or more runs per task before drawing conclusions.`
    );
  } else {
    lines.push(`Verdict: ${rateB > rateA ? "B" : "A"} is better; the 95% intervals do not overlap.`);
  }
  lines.push("Note: per-task differences from a handful of runs are anecdotes, not evidence.");
  return lines.join("\n");
}
