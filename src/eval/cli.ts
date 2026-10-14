import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ConfigError, parseFlag, resolveBackend } from "../config.js";
import { startBackend, stopAll } from "../backend.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { ContextManager } from "../agent/context-manager.js";
import { toolsToApiFormat } from "../agent/tools.js";
import { buildEvalTools, runTask, verifyTask } from "./runner.js";
import { TaskError, loadTasks, selectTasks } from "./tasks.js";
import { HARNESS_VERSION } from "./version.js";
import { ReportError, formatComparison, formatSummary, loadReport, reportFilePath, writeReport } from "./report.js";
import type { EvalReport, RunResult, TaskSpec } from "./types.js";

const BUILTIN_TASKS_DIR = fileURLToPath(new URL("../../eval-tasks", import.meta.url));

const VALUE_FLAGS = new Set([
  "--tasks", "--task", "--runs", "--out", "--label", "--temperature", "--transcripts",
  // handled by the shared backend code
  "--base-url", "--model", "--context", "--api-key",
]);
const BOOLEAN_FLAGS = new Set(["--list", "--verify-tasks", "--keep-workdirs", "--help"]);

export const HELP = `Usage: mithril eval [options]

Runs coding tasks against a model and reports how many it completes.

Model (same as the chat app; with none of these, the model picker opens):
  --base-url <url> --model <id>   use a server that is already running
  --context <tokens>              context window size (see the README)
  --temperature <0-2>             sampling temperature (default: the server's)

Choosing what to run:
  --task <id[,id...]>             run only these tasks
  --tasks <dir>                   use your own tasks directory instead of the built-in one
  --runs <n>                      runs per task, 1-50 (default 1; 3 or more gives steadier numbers)
  --list                          list the tasks and exit
  --verify-tasks                  check every task is well-formed (no model needed) and exit

Output:
  --out <dir>                     where results are written (default ./eval-results)
  --label <text>                  name for this run, stored in the results
  --transcripts <failed|all|none> conversation transcripts to keep (default failed)
  --keep-workdirs                 keep each run's scratch directory for inspection

Comparing:
  --compare <a.json> <b.json>     compare two results files and exit
`;

export interface EvalOptions {
  help: boolean;
  list: boolean;
  verify: boolean;
  compare?: [string, string];
  tasksDir: string;
  taskIds?: string[];
  runs: number;
  outDir: string;
  label: string;
  temperature?: number;
  transcripts: "all" | "failed" | "none";
  keepWorkdirs: boolean;
}

// Rejects anything unrecognised. Silently ignoring a typo such as `--run 3`
// would quietly produce a different experiment than the one intended.
export function validateFlags(argv: string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--compare") {
      i += 2;
    } else if (VALUE_FLAGS.has(arg)) {
      i += 1;
    } else if (!BOOLEAN_FLAGS.has(arg)) {
      throw new ConfigError(
        arg.startsWith("--") ? `Unknown option ${arg}. Run "mithril eval --help" for the list.` : `Unexpected argument "${arg}".`
      );
    }
  }
}

function requiredValue(argv: string[], flag: string): string | undefined {
  const value = parseFlag(argv, flag);
  if (argv.includes(flag) && value === undefined) throw new ConfigError(`${flag} needs a value.`);
  return value;
}

export function parseEvalArgs(argv: string[], builtinDir: string = BUILTIN_TASKS_DIR): EvalOptions {
  validateFlags(argv);

  const runsRaw = requiredValue(argv, "--runs");
  const runs = runsRaw === undefined ? 1 : Number(runsRaw);
  if (!Number.isInteger(runs) || runs < 1 || runs > 50) throw new ConfigError(`--runs must be a whole number from 1 to 50 (got "${runsRaw}").`);

  const tempRaw = requiredValue(argv, "--temperature");
  const temperature = tempRaw === undefined ? undefined : Number(tempRaw);
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new ConfigError(`--temperature must be a number from 0 to 2 (got "${tempRaw}").`);
  }

  const transcripts = (requiredValue(argv, "--transcripts") ?? "failed") as EvalOptions["transcripts"];
  if (!["all", "failed", "none"].includes(transcripts)) throw new ConfigError(`--transcripts must be failed, all or none.`);

  let compare: [string, string] | undefined;
  const ci = argv.indexOf("--compare");
  if (ci !== -1) {
    const a = argv[ci + 1], b = argv[ci + 2];
    if (!a || !b || a.startsWith("--") || b.startsWith("--")) throw new ConfigError("--compare needs two results files: --compare a.json b.json");
    compare = [a, b];
  }

  const taskList = requiredValue(argv, "--task");
  const tasksDirRaw = requiredValue(argv, "--tasks");

  const options: EvalOptions = {
    help: argv.includes("--help"),
    list: argv.includes("--list"),
    verify: argv.includes("--verify-tasks"),
    tasksDir: tasksDirRaw ? path.resolve(tasksDirRaw) : builtinDir,
    runs,
    outDir: path.resolve(requiredValue(argv, "--out") ?? "eval-results"),
    label: requiredValue(argv, "--label") ?? "",
    transcripts,
    keepWorkdirs: argv.includes("--keep-workdirs"),
  };
  if (compare) options.compare = compare;
  if (taskList) options.taskIds = taskList.split(",").map((s) => s.trim()).filter(Boolean);
  if (temperature !== undefined) options.temperature = temperature;
  return options;
}

function fingerprint(system: string, defs: unknown): string {
  return createHash("sha1").update(JSON.stringify({ system, defs })).digest("hex").slice(0, 8);
}

const kTokens = (n: number | null) => (n === null ? "n/a" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function runLine(r: RunResult): string {
  const m = r.metrics;
  const stats = `${plural(m.modelCalls, "step")}, ${plural(m.toolCalls, "tool call")}, peak prompt ${kTokens(m.peakPromptTokens)}, ${(r.durationMs / 1000).toFixed(1)}s`;
  return r.passed ? `PASS  (${stats})` : `FAIL  ${r.failureKind}  (${stats})`;
}

// Without model flags the app opens an interactive picker, which needs a terminal.
export function checkInteractive(argv: string[], isTTY: boolean | undefined): void {
  if (resolveBackend(argv).kind === "local" && !isTTY) {
    throw new ConfigError("No terminal available for the model picker. Pass --base-url and --model to use a server that is already running.");
  }
}

interface InterruptState {
  // Before the runs begin, Ctrl+C just quits. Once they are running it stops
  // gracefully and saves what has been measured.
  phase: "starting" | "running";
  interrupted: boolean;
  exitCode: number;
  controller: AbortController;
}

// Ctrl+C (or `docker stop`) during a run must not throw away the results so
// far. The first signal aborts the run in progress and lets the loop save and
// print what it has; a second one quits immediately. Returns a function that
// removes the handlers again.
function installEvalSignalHandlers(state: InterruptState): () => void {
  const handler = (code: number, name: string) => () => {
    if (state.phase !== "running" || state.interrupted) {
      stopAll();
      process.exit(code);
    }
    state.interrupted = true;
    state.exitCode = code;
    process.stdout.write(`\nReceived ${name}: stopping and saving the results so far (send it again to quit immediately)...\n`);
    state.controller.abort();
  };
  const onInt = handler(130, "SIGINT");
  const onTerm = handler(143, "SIGTERM");
  const onUncaught = (err: Error) => {
    console.error(`mithril eval hit an unexpected error: ${err.message}`);
    stopAll();
    process.exit(1);
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("uncaughtException", onUncaught);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    process.off("uncaughtException", onUncaught);
  };
}

async function runEvaluation(opts: EvalOptions, tasks: TaskSpec[], argv: string[]): Promise<number> {
  checkInteractive(argv, process.stdin.isTTY);

  const state: InterruptState = { phase: "starting", interrupted: false, exitCode: 130, controller: new AbortController() };
  const removeHandlers = installEvalSignalHandlers(state);
  try {
    console.log(
      "Eval mode approves file edits automatically and runs the commands the model asks for (only the commands each\n" +
        "task allows, no shell operators) inside a temporary copy of each task. That is an accident guard, not a\n" +
        "sandbox: run evals in a container or VM if you don't trust the model.\n"
    );
    if (opts.runs === 1) console.log("Tip: models are not deterministic. Use --runs 3 or more for numbers you can rely on.\n");

    const startedAt = new Date().toISOString();
    const { chatConfig, contextWindow } = await startBackend(argv);

    const evalTools = buildEvalTools(["node"]);
    const system = buildSystemPrompt(evalTools);
    const defs = toolsToApiFormat(evalTools);
    const manager = new ContextManager({ contextWindow: contextWindow.window });
    const fixed = manager.fixedPromptTokens([{ role: "system", content: system }], defs);
    if (fixed > manager.maxInputTokens * 0.6) {
      console.log(`Warning: the system prompt and tools use ~${fixed} tokens of a ${contextWindow.window}-token window; expect context failures.\n`);
    }

    const results = new Map<string, RunResult[]>(tasks.map((t) => [t.id, []]));
    const plannedRuns = tasks.length * opts.runs;
    const fingerprintValue = fingerprint(system, defs);

    // Tasks that have not produced a run yet are left out, so a partial file
    // only describes what was actually measured.
    const build = (partial: boolean): EvalReport => ({
      schemaVersion: 1,
      harnessVersion: HARNESS_VERSION,
      partial,
      plannedRuns,
      label: opts.label,
      startedAt,
      finishedAt: new Date().toISOString(),
      node: process.version,
      backend: { baseUrl: chatConfig.baseUrl, model: chatConfig.model },
      contextWindow: { window: contextWindow.window, source: contextWindow.source },
      temperature: opts.temperature ?? null,
      runsPerTask: opts.runs,
      fixedOverheadTokens: fixed,
      promptFingerprint: fingerprintValue,
      tasks: tasks.filter((t) => results.get(t.id)!.length > 0).map((t) => ({ id: t.id, title: t.title, type: t.type, runs: results.get(t.id)! })),
    });

    console.log(`Running ${tasks.length} task(s) x ${opts.runs} run(s). Results are saved after every run:`);
    console.log(`  ${reportFilePath(opts.outDir, startedAt, opts.label)}`);
    console.log("Press Ctrl+C to stop early; what has been measured so far is kept.\n");

    state.phase = "running";
    outer: for (const task of tasks) {
      for (let run = 1; run <= opts.runs; run++) {
        if (state.interrupted) break outer;
        process.stdout.write(`  ${task.id} [${run}/${opts.runs}] ... `);
        const result = await runTask(task, {
          chatConfig,
          contextWindow: contextWindow.window,
          temperature: opts.temperature,
          run,
          signal: state.controller.signal,
          keepWorkdir: opts.keepWorkdirs,
          transcripts: opts.transcripts,
          onWorkdir: opts.keepWorkdirs ? (dir) => process.stdout.write(`(workdir ${dir}) `) : undefined,
        });
        if (state.interrupted && result.stopReason === "aborted") {
          console.log("interrupted (this unfinished run is not counted)");
          break outer;
        }
        results.get(task.id)!.push(result);
        console.log(runLine(result));
        await writeReport(build(true), opts.outDir);
      }
    }

    const report = build(state.interrupted);
    console.log("\n" + formatSummary(report));
    const file = await writeReport(report, opts.outDir);
    console.log(`\nResults written to ${file}`);
    return state.interrupted ? state.exitCode : 0;
  } finally {
    removeHandlers();
  }
}

// Returns the process exit code.
export async function runEvalCli(argv: string[]): Promise<number> {
  try {
    const opts = parseEvalArgs(argv);
    if (opts.help) {
      console.log(HELP);
      return 0;
    }
    if (opts.compare) {
      console.log(formatComparison(await loadReport(opts.compare[0]), await loadReport(opts.compare[1])));
      return 0;
    }

    const tasks = selectTasks(await loadTasks(opts.tasksDir), opts.taskIds);

    if (opts.list) {
      for (const t of tasks) console.log(`${t.id.padEnd(26)} ${t.type.padEnd(7)} ${t.title}`);
      return 0;
    }

    if (opts.verify) {
      let bad = 0;
      for (const t of tasks) {
        const r = await verifyTask(t);
        const ok = r.fixtureFails && r.solutionPasses;
        if (!ok) bad++;
        console.log(`${ok ? "ok " : "BAD"}  ${t.id}${ok ? "" : `: ${r.detail}`}`);
      }
      console.log(bad === 0 ? `\nAll ${tasks.length} task(s) are valid.` : `\n${bad} task(s) are invalid.`);
      return bad === 0 ? 0 : 1;
    }

    return await runEvaluation(opts, tasks, argv);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof TaskError || err instanceof ReportError) {
      console.error(`mithril eval: ${err.message}`);
      return 2;
    }
    throw err;
  }
}
