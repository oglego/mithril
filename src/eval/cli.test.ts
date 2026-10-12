import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEvalArgs, validateFlags, checkInteractive, runEvalCli, HELP } from "./cli.js";
import { ConfigError } from "../config.js";
import { loadTasks } from "./tasks.js";
import { oracleScript, startScriptedModel } from "./testing.js";
import type { EvalReport } from "./types.js";

const TASKS_DIR = fileURLToPath(new URL("../../eval-tasks", import.meta.url));
const scratch: string[] = [];
after(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

// Captures console output (not process.stdout, which the test runner shares).
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const log = console.log, err = console.error;
  let out = "";
  console.log = (...a: unknown[]) => void (out += a.join(" ") + "\n");
  console.error = (...a: unknown[]) => void (out += a.join(" ") + "\n");
  try {
    return { result: await fn(), out };
  } finally {
    console.log = log;
    console.error = err;
  }
}

// ---- argument parsing ----

test("defaults", () => {
  const o = parseEvalArgs([], "/builtin");
  assert.deepEqual(
    { runs: o.runs, transcripts: o.transcripts, tasksDir: o.tasksDir, label: o.label, keep: o.keepWorkdirs, list: o.list, verify: o.verify },
    { runs: 1, transcripts: "failed", tasksDir: "/builtin", label: "", keep: false, list: false, verify: false }
  );
  assert.equal(path.basename(o.outDir), "eval-results");
  assert.ok(path.isAbsolute(o.outDir));
  assert.equal(o.temperature, undefined);
  assert.equal(o.taskIds, undefined);
});

test("every option is parsed", () => {
  const o = parseEvalArgs(
    ["--runs", "5", "--temperature", "0.2", "--task", "a, b", "--tasks", "./mine", "--out", "res", "--label", "x y", "--transcripts", "all", "--keep-workdirs", "--base-url", "http://h", "--model", "m", "--context", "4096"],
    "/builtin"
  );
  assert.equal(o.runs, 5);
  assert.equal(o.temperature, 0.2);
  assert.deepEqual(o.taskIds, ["a", "b"]);
  assert.equal(o.tasksDir, path.resolve("./mine"));
  assert.equal(o.label, "x y");
  assert.equal(o.transcripts, "all");
  assert.equal(o.keepWorkdirs, true);
  assert.deepEqual(parseEvalArgs(["--compare", "a.json", "b.json"], "/b").compare, ["a.json", "b.json"]);
});

test("bad input is rejected with a specific message instead of being ignored", () => {
  const bad: [string[], RegExp][] = [
    [["--run", "3"], /Unknown option --run/],
    [["--runs", "0"], /--runs must be/],
    [["--runs", "51"], /--runs must be/],
    [["--runs", "abc"], /--runs must be/],
    [["--runs", "2.5"], /--runs must be/],
    [["--runs"], /--runs needs a value/],
    [["--temperature", "3"], /--temperature must be/],
    [["--temperature", "hot"], /--temperature must be/],
    [["--transcripts", "some"], /--transcripts must be/],
    [["--task"], /--task needs a value/],
    [["--compare", "only-one.json"], /--compare needs two/],
    [["--compare", "a.json", "--list"], /--compare needs two/],
    [["stray"], /Unexpected argument "stray"/],
  ];
  for (const [argv, pattern] of bad) {
    assert.throws(() => parseEvalArgs(argv, "/b"), (e: unknown) => e instanceof ConfigError && pattern.test(e.message), argv.join(" "));
  }
});

test("validateFlags accepts the shared backend flags", () => {
  validateFlags(["--base-url", "http://x", "--model", "m", "--context", "4096", "--runs", "2"]);
});

test("the model picker needs a terminal; a server given by flags does not", () => {
  assert.throws(() => checkInteractive([], false), ConfigError);
  assert.throws(() => checkInteractive([], undefined), /--base-url and --model/);
  checkInteractive([], true);
  checkInteractive(["--base-url", "http://x", "--model", "m"], false);
});

// ---- commands that need no model ----

test("--help, --list and --verify-tasks", async () => {
  assert.deepEqual(await capture(() => runEvalCli(["--help"])), { result: 0, out: HELP + "\n" });

  const list = await capture(() => runEvalCli(["--list"]));
  assert.equal(list.result, 0);
  for (const t of await loadTasks(TASKS_DIR)) assert.match(list.out, new RegExp(t.id));

  const verify = await capture(() => runEvalCli(["--verify-tasks"]));
  assert.equal(verify.result, 0);
  assert.match(verify.out, /All 9 task\(s\) are valid/);

  const subset = await capture(() => runEvalCli(["--verify-tasks", "--task", "fix-off-by-one"]));
  assert.match(subset.out, /All 1 task\(s\) are valid/);
});

test("--verify-tasks fails (exit 1) on a task whose fixture already passes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mithril-cli-"));
  scratch.push(root);
  const dir = path.join(root, "trivial");
  await mkdir(path.join(dir, "fixture"), { recursive: true });
  await mkdir(path.join(dir, "solution"), { recursive: true });
  await writeFile(path.join(dir, "task.json"), JSON.stringify({ id: "trivial", title: "t", prompt: "p" }));
  await writeFile(path.join(dir, "check.mjs"), "process.exit(0)"); // passes without any work
  const { result, out } = await capture(() => runEvalCli(["--verify-tasks", "--tasks", root]));
  assert.equal(result, 1);
  assert.match(out, /BAD\s+trivial: the unmodified fixture already passes/);
});

test("user mistakes exit with code 2 and a one-line message", async () => {
  for (const argv of [["--run", "3"], ["--task", "no-such-task"], ["--tasks", "/no/such/dir"], ["--compare", "/no/a.json", "/no/b.json"], ["--api-key", "sk-secret", "--task", "fix-off-by-one"]]) {
    const { result, out } = await capture(() => runEvalCli(argv));
    assert.equal(result, 2, argv.join(" "));
    assert.match(out, /^mithril eval: /);
    assert.ok(!out.includes("sk-secret"), "a key passed on the command line is never echoed");
  }
});

// ---- the whole thing, end to end ----

test("a full evaluation run: backend flags, real tasks, results file, summary, then --compare", async () => {
  const tasks = await loadTasks(TASKS_DIR);
  const model = await startScriptedModel(oracleScript(tasks));
  const out = await mkdtemp(path.join(os.tmpdir(), "mithril-evalrun-"));
  scratch.push(out);
  try {
    const argv = ["--base-url", model.baseUrl, "--model", "scripted", "--task", "fix-off-by-one,answer-code-question", "--runs", "2", "--out", out, "--label", "oracle run"];
    const first = await capture(() => runEvalCli(argv));
    assert.equal(first.result, 0, first.out);
    assert.match(first.out, /Overall: 4\/4 passed/);
    assert.match(first.out, /fix-off-by-one\s+2\/2/);
    assert.match(first.out, /answer-code-question\s+2\/2/);
    assert.match(first.out, /Results written to /);
    assert.match(first.out, /accident guard, not a\s+sandbox/, "the safety notice is shown");

    const files = (await readdir(out)).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /oracle-run\.json$/);
    const saved = JSON.parse(await readFile(path.join(out, files[0]!), "utf-8")) as EvalReport;
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.backend.model, "scripted");
    assert.equal(saved.runsPerTask, 2);
    assert.equal(saved.tasks.length, 2);
    assert.ok(saved.tasks.every((t) => t.runs.length === 2 && t.runs.every((r) => r.passed)));
    assert.equal(saved.contextWindow.source, "default");
    assert.ok(saved.fixedOverheadTokens > 0 && saved.fixedOverheadTokens < 900);
    assert.match(saved.promptFingerprint, /^[0-9a-f]{8}$/);

    const cmp = await capture(() => runEvalCli(["--compare", path.join(out, files[0]!), path.join(out, files[0]!)]));
    assert.equal(cmp.result, 0);
    assert.match(cmp.out, /Same model and same prompt\+tools/);
    assert.match(cmp.out, /Verdict: within noise/);
  } finally {
    await model.close();
  }
});

test("the prompt fingerprint is stable between runs and differs when the prompt differs", async () => {
  const tasks = await loadTasks(TASKS_DIR);
  const fingerprints: string[] = [];
  const model = await startScriptedModel(oracleScript(tasks));
  const out = await mkdtemp(path.join(os.tmpdir(), "mithril-fp-"));
  scratch.push(out);
  try {
    for (let i = 0; i < 2; i++) {
      await capture(() => runEvalCli(["--base-url", model.baseUrl, "--model", "scripted", "--task", "create-clamp-module", "--out", out, "--label", `r${i}`]));
    }
    for (const f of (await readdir(out)).filter((n) => n.endsWith(".json"))) {
      fingerprints.push((JSON.parse(await readFile(path.join(out, f), "utf-8")) as EvalReport).promptFingerprint);
    }
  } finally {
    await model.close();
  }
  assert.equal(fingerprints.length, 2);
  assert.equal(fingerprints[0], fingerprints[1]);
});
