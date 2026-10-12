import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTask, runCheck, verifyTask, buildEvalTools } from "./runner.js";
import { loadTasks, snapshotDir } from "./tasks.js";
import { oracleScript, startScriptedModel, type ScriptedReply } from "./testing.js";
import type { TaskSpec } from "./types.js";

const TASKS_DIR = fileURLToPath(new URL("../../eval-tasks", import.meta.url));
const tasks = await loadTasks(TASKS_DIR);
const byId = (id: string): TaskSpec => tasks.find((t) => t.id === id)!;

const scratch: string[] = [];
after(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

async function withModel<T>(
  script: Parameters<typeof startScriptedModel>[0],
  fn: (chatConfig: { baseUrl: string; model: string }, model: Awaited<ReturnType<typeof startScriptedModel>>) => Promise<T>
): Promise<T> {
  const model = await startScriptedModel(script);
  try {
    return await fn({ baseUrl: model.baseUrl, model: "scripted" }, model);
  } finally {
    await model.close();
  }
}

const WINDOW = 8192;

// ---- the tasks themselves ----

test("every built-in task is well-formed: the fixture fails and the reference solution passes", async () => {
  for (const task of tasks) {
    const r = await verifyTask(task);
    assert.equal(r.fixtureFails, true, `${task.id}: the unmodified fixture must not already pass`);
    assert.equal(r.solutionPasses, true, `${task.id}: the reference solution must pass (${r.detail})`);
  }
});

// ---- end to end: real agent loop, real tools, real checks ----

test("an oracle model that replays each reference solution passes every task", async () => {
  await withModel(oracleScript(tasks), async (chatConfig) => {
    for (const task of tasks) {
      const r = await runTask(task, { chatConfig, contextWindow: WINDOW, run: 1 });
      assert.equal(r.passed, true, `${task.id}: ${r.check.output}`);
      assert.equal(r.stopReason, "answered");
      assert.equal(r.failureKind, undefined);
      assert.equal(r.transcript, undefined, "passing runs keep no transcript by default");
      if (task.type === "edit") assert.ok(r.changedFiles.length > 0, `${task.id} should have changed files`);
      else assert.deepEqual(r.changedFiles, []);
    }
  });
});

test("a model that does nothing fails every task, for the right reason", async () => {
  await withModel(() => ({ content: "All done, nothing to change." }), async (chatConfig) => {
    for (const task of tasks) {
      const r = await runTask(task, { chatConfig, contextWindow: WINDOW, run: 1 });
      assert.equal(r.passed, false, `${task.id} must not pass without doing anything`);
      assert.equal(r.failureKind, task.type === "answer" ? "wrong_answer" : "no_changes", task.id);
      assert.ok(r.transcript && r.transcript.length >= 3, "failed runs keep their transcript");
    }
  });
});

// ---- the checks must reject plausible cheats and half-fixes ----

async function attempt(taskId: string, toolCalls: { name: string; arguments: object }[], reply = "Done.") {
  return withModel(
    ({ messages }) => (messages[messages.length - 1]!.role === "tool" ? { content: reply } : { toolCalls }),
    (chatConfig) => runTask(byId(taskId), { chatConfig, contextWindow: WINDOW, run: 1 })
  );
}

test("checks reject cheats: hiding the symptom, rewriting the tests, partial renames, broken JSON", async () => {
  const cases: [string, { name: string; arguments: object }[], string][] = [
    [
      "fix-crash-from-error",
      [{ name: "edit_file", arguments: { path: "src/main.mjs", target_content: "config.server.port", replacement_content: "config.sever.port" } }],
      "patching main.mjs to read the misspelled key",
    ],
    [
      "fix-failing-test",
      [{ name: "edit_file", arguments: { path: "test/pricing.test.mjs", target_content: "applyDiscount(100, 0.2), 80", replacement_content: "applyDiscount(100, 0.2), 20" } }],
      "changing the test to match the bug",
    ],
    [
      "rename-across-files",
      [{ name: "edit_file", arguments: { path: "src/users.mjs", target_content: "getUser", replacement_content: "fetchUser" } }],
      "renaming only the definition (breaks callers)",
    ],
    [
      "edit-json-config",
      [{ name: "edit_file", arguments: { path: "config.json", target_content: '"port": 8080', replacement_content: '"port": 9090' } }],
      "changing the port but not the log level",
    ],
    [
      "edit-json-config",
      [{ name: "write_file", arguments: { path: "config.json", content: '{ "server": { "port": 9090 }', overwrite: true } }],
      "writing invalid JSON",
    ],
    [
      "add-currency-param",
      [{ name: "write_file", arguments: { path: "src/format.mjs", content: 'export function formatPrice(amount, currency = "USD") { return "$" + amount.toFixed(2); }\n', overwrite: true } }],
      "accepting the parameter but ignoring it",
    ],
  ];
  for (const [taskId, calls, why] of cases) {
    const r = await attempt(taskId, calls);
    assert.equal(r.passed, false, `${taskId}: ${why} must NOT pass`);
    assert.equal(r.failureKind, "check_failed", `${taskId}: ${why}`);
  }
});

test("an answer task rejects a reply that gives the decoy answer", async () => {
  const r = await attempt("answer-code-question", [], "The PORT variable, defaulting to 8080.");
  assert.equal(r.passed, false);
  assert.equal(r.failureKind, "wrong_answer");
});

// ---- measurement ----

test("malformed calls and tool failures are counted separately, from structured events", async () => {
  const script = ({ call }: { call: number }): ScriptedReply => {
    if (call === 1) return { toolCalls: [{ name: "delete_everything", arguments: {} }] }; // unknown tool
    if (call === 2) return { toolCalls: [{ name: "read_file", arguments: "{not json" }] }; // bad arguments
    if (call === 3) return { toolCalls: [{ name: "read_file", arguments: { path: "missing.txt" } }] }; // tool error
    if (call === 4) return { toolCalls: [{ name: "read_file", arguments: { path: "src/paginate.mjs" } }] }; // ok
    return { content: "ok" };
  };
  await withModel(script, async (chatConfig) => {
    const r = await runTask(byId("fix-off-by-one"), { chatConfig, contextWindow: WINDOW, run: 1 });
    const o = r.metrics.outcomes;
    assert.deepEqual(
      { unknown: o.unknown_tool, bad: o.bad_arguments, error: o.tool_error, ok: o.ok, declined: o.declined },
      { unknown: 1, bad: 1, error: 1, ok: 1, declined: 0 }
    );
    assert.equal(r.metrics.toolCalls, 4);
    assert.equal(r.metrics.modelCalls, 5);
    assert.equal(r.metrics.toolCallsByName.read_file, 3);
  });
});

test("token usage reported by the server is summed, and the peak prompt is tracked", async () => {
  const script = ({ call }: { call: number }): ScriptedReply =>
    call < 3
      ? { toolCalls: [{ name: "list_dir", arguments: {} }], usage: { prompt_tokens: 1000 * call, completion_tokens: 10 } }
      : { content: "ok", usage: { prompt_tokens: 3000, completion_tokens: 5 } };
  await withModel(script, async (chatConfig) => {
    const r = await runTask(byId("fix-off-by-one"), { chatConfig, contextWindow: WINDOW, run: 1 });
    assert.equal(r.metrics.promptTokens, 1000 + 2000 + 3000);
    assert.equal(r.metrics.peakPromptTokens, 3000);
    assert.equal(r.metrics.completionTokens, 25);
  });
});

test("token usage is null, not zero, when the server doesn't report it", async () => {
  await withModel(() => ({ content: "ok" }), async (chatConfig) => {
    const r = await runTask(byId("fix-off-by-one"), { chatConfig, contextWindow: WINDOW, run: 1 });
    assert.equal(r.metrics.promptTokens, null);
    assert.equal(r.metrics.peakPromptTokens, null);
    assert.equal(r.metrics.completionTokens, null);
  });
});

// ---- command policy during a run ----

test("run_command: allowed commands run, anything else is declined and not executed", async () => {
  const script = ({ call }: { call: number }): ScriptedReply => {
    if (call === 1) return { toolCalls: [{ name: "run_command", arguments: { command: "node --test" } }] };
    if (call === 2) return { toolCalls: [{ name: "run_command", arguments: { command: "node -v; echo pwned > pwned.txt" } }] };
    if (call === 3) return { toolCalls: [{ name: "run_command", arguments: { command: "rm -rf src" } }] };
    return { content: "ok" };
  };
  await withModel(script, async (chatConfig) => {
    const r = await runTask(byId("fix-off-by-one"), { chatConfig, contextWindow: WINDOW, run: 1, transcripts: "all" });
    assert.equal(r.metrics.outcomes.ok, 1, "`node --test` is allowed (a failing test run is still a normal result)");
    assert.equal(r.metrics.outcomes.declined, 2);
    const results = r.transcript!.filter((m) => m.role === "tool").map((m) => m.content);
    assert.match(results[0]!, /^\[Exit code: 1/, "the buggy fixture's tests really did fail");
    assert.match(results[1]!, /declined/);
    assert.match(results[2]!, /declined/);
  });
});

// ---- nested test runners must not produce vacuous passes ----

test("a `node --test` run by the agent really runs the tests even when the harness itself runs under node:test", async () => {
  const had = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = "child-v8"; // what `node --test` sets for its children
  try {
    await withModel(
      ({ call }) => (call === 1 ? { toolCalls: [{ name: "run_command", arguments: { command: "node --test" } }] } : { content: "ok" }),
      async (chatConfig) => {
        const r = await runTask(byId("fix-off-by-one"), { chatConfig, contextWindow: WINDOW, run: 1, transcripts: "all" });
        const output = r.transcript!.find((m) => m.role === "tool")!.content;
        assert.match(output, /^\[Exit code: 1/, "the buggy fixture's tests must really run and fail, not be skipped");
        assert.ok(!/recursively/.test(output));
        assert.equal(process.env.NODE_TEST_CONTEXT, "child-v8", "the variable is restored after the run");
      }
    );
  } finally {
    if (had === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = had;
  }
});

test("checks do not inherit NODE_TEST_CONTEXT either", async () => {
  const had = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = "child-v8";
  try {
    const task = await makeTask({ check: "process.exit(process.env.NODE_TEST_CONTEXT === undefined ? 0 : 1);" });
    assert.equal(runCheck(task, path.join(task.dir, "fixture"), path.join(task.dir, "reply.txt")).passed, true);
  } finally {
    if (had === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = had;
  }
});

// ---- failure modes ----

test("a model that never finishes hits max_steps", async () => {
  await withModel(() => ({ toolCalls: [{ name: "list_dir", arguments: {} }] }), async (chatConfig, model) => {
    const r = await runTask({ ...byId("fix-off-by-one"), maxSteps: 3 }, { chatConfig, contextWindow: WINDOW, run: 1 });
    assert.equal(r.stopReason, "max_steps");
    assert.equal(r.failureKind, "max_steps");
    assert.equal(model.calls(), 3);
  });
});

test("a model that is too slow is aborted at the task timeout", async () => {
  await withModel(() => ({ content: "late", delayMs: 5000 }), async (chatConfig) => {
    const started = Date.now();
    const r = await runTask({ ...byId("fix-off-by-one"), timeoutSeconds: 1 }, { chatConfig, contextWindow: WINDOW, run: 1 });
    assert.equal(r.stopReason, "aborted");
    assert.equal(r.failureKind, "timeout");
    assert.ok(Date.now() - started < 4000, "must not wait for the slow response");
  });
});

test("a server error is reported as server_error", async () => {
  await withModel(() => ({ status: 500 }), async (chatConfig) => {
    const r = await runTask(byId("fix-off-by-one"), { chatConfig, contextWindow: WINDOW, run: 1 });
    assert.equal(r.stopReason, "server_error");
    assert.equal(r.failureKind, "server_error");
  });
});

test("a context window too small for the agent is reported as context_limit, without calling the model", async () => {
  await withModel(() => ({ content: "never reached" }), async (chatConfig, model) => {
    const r = await runTask(byId("fix-off-by-one"), { chatConfig, contextWindow: 1024, run: 1 });
    assert.equal(r.stopReason, "context");
    assert.equal(r.failureKind, "context_limit");
    assert.equal(model.calls(), 0);
  });
});

// ---- isolation ----

test("runs are isolated: the fixture is untouched, the scratch dir is removed, the project root is restored", async () => {
  const task = byId("fix-off-by-one");
  const fixtureBefore = await snapshotDir(path.join(task.dir, "fixture"));
  const sentinel = "/sentinel/project/root";
  process.env.MITHRIL_PROJECT_ROOT = sentinel;
  let workdir = "";
  try {
    await withModel(oracleScript(tasks), async (chatConfig) => {
      const r = await runTask(task, { chatConfig, contextWindow: WINDOW, run: 1, onWorkdir: (d) => (workdir = d) });
      assert.equal(r.passed, true);
    });
    assert.equal(process.env.MITHRIL_PROJECT_ROOT, sentinel, "the process-wide project root must be restored");
  } finally {
    delete process.env.MITHRIL_PROJECT_ROOT;
  }
  assert.deepEqual(await snapshotDir(path.join(task.dir, "fixture")), fixtureBefore, "the original fixture must never be modified");
  assert.equal(existsSync(workdir), false, "the scratch directory is cleaned up");
  await runTaskRestoresUnsetRoot();
});

async function runTaskRestoresUnsetRoot(): Promise<void> {
  assert.equal(process.env.MITHRIL_PROJECT_ROOT, undefined);
  await withModel(() => ({ content: "ok" }), async (chatConfig) => {
    await runTask(byId("fix-off-by-one"), { chatConfig, contextWindow: WINDOW, run: 1 });
    assert.equal(process.env.MITHRIL_PROJECT_ROOT, undefined, "an unset project root must stay unset");
  });
}

test("keepWorkdir leaves the scratch directory for inspection", async () => {
  let workdir = "";
  await withModel(oracleScript(tasks), async (chatConfig) => {
    await runTask(byId("fix-off-by-one"), { chatConfig, contextWindow: WINDOW, run: 1, keepWorkdir: true, onWorkdir: (d) => (workdir = d) });
  });
  scratch.push(path.dirname(workdir));
  await access(path.join(workdir, "src", "paginate.mjs"));
});

test("the agent cannot read or write outside its scratch project", async () => {
  const outside = path.join(os.tmpdir(), `mithril-escape-${process.pid}.txt`);
  const script = ({ call }: { call: number }): ScriptedReply => {
    if (call === 1) return { toolCalls: [{ name: "read_file", arguments: { path: "../../../../etc/hostname" } }] };
    if (call === 2) return { toolCalls: [{ name: "write_file", arguments: { path: outside, content: "x", overwrite: true } }] };
    if (call === 3) return { toolCalls: [{ name: "write_file", arguments: { path: "../escaped.txt", content: "x", overwrite: true } }] };
    return { content: "ok" };
  };
  scratch.push(outside);
  await withModel(script, async (chatConfig) => {
    const r = await runTask(byId("fix-off-by-one"), { chatConfig, contextWindow: WINDOW, run: 1 });
    assert.equal(r.metrics.outcomes.tool_error, 3, "all three escape attempts are refused");
  });
  assert.equal(existsSync(outside), false);
});

// ---- transcripts ----

test("transcript retention: failed by default, all or none on request", async () => {
  await withModel(() => ({ content: "nothing" }), async (chatConfig) => {
    const base = { chatConfig, contextWindow: WINDOW, run: 1 };
    assert.ok((await runTask(byId("fix-off-by-one"), base)).transcript);
    assert.ok((await runTask(byId("fix-off-by-one"), { ...base, transcripts: "all" })).transcript);
    assert.equal((await runTask(byId("fix-off-by-one"), { ...base, transcripts: "none" })).transcript, undefined);
  });
  await withModel(oracleScript(tasks), async (chatConfig) => {
    const passing = await runTask(byId("fix-off-by-one"), { chatConfig, contextWindow: WINDOW, run: 1, transcripts: "all" });
    assert.ok(passing.transcript, "transcripts: all keeps passing runs too");
  });
});

// ---- tool set parity ----

test("eval tools match the chat app's tool set", () => {
  const names = buildEvalTools(["node"]).map((t) => t.name).sort();
  assert.deepEqual(names, ["edit_file", "find_files", "list_dir", "read_file", "run_command", "search_code", "write_file"]);
});

// ---- verifyTask catches broken tasks ----

async function makeTask(opts: { check: string; fixtureFile?: string; solutionFile?: string; type?: "edit" | "answer" }): Promise<TaskSpec> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mithril-task-"));
  scratch.push(dir);
  await mkdir(path.join(dir, "fixture"), { recursive: true });
  await mkdir(path.join(dir, "solution"), { recursive: true });
  await writeFile(path.join(dir, "fixture", "a.txt"), opts.fixtureFile ?? "broken");
  await writeFile(path.join(dir, "solution", "a.txt"), opts.solutionFile ?? "fixed");
  await writeFile(path.join(dir, "check.mjs"), opts.check);
  return {
    id: "t", title: "t", prompt: "p", type: opts.type ?? "edit", maxSteps: 5, timeoutSeconds: 10,
    checkTimeoutSeconds: 5, allowedCommands: ["node"], dir,
  };
}

const CHECK_A_TXT_IS_FIXED = `import { readFileSync } from "node:fs";
import path from "node:path";
process.exit(readFileSync(path.join(process.argv[2], "a.txt"), "utf-8") === "fixed" ? 0 : 1);`;

test("verifyTask accepts a sound task", async () => {
  const r = await verifyTask(await makeTask({ check: CHECK_A_TXT_IS_FIXED }));
  assert.deepEqual([r.fixtureFails, r.solutionPasses], [true, true]);
});

test("verifyTask flags a task whose fixture already passes", async () => {
  const r = await verifyTask(await makeTask({ check: CHECK_A_TXT_IS_FIXED, fixtureFile: "fixed" }));
  assert.equal(r.fixtureFails, false);
  assert.match(r.detail, /already passes/);
});

test("verifyTask flags a task whose reference solution is rejected", async () => {
  const r = await verifyTask(await makeTask({ check: CHECK_A_TXT_IS_FIXED, solutionFile: "still broken" }));
  assert.equal(r.solutionPasses, false);
});

test("a check that hangs is killed at its timeout and counts as a failure", async () => {
  const task = await makeTask({ check: "setInterval(() => {}, 1000);" });
  const t = { ...task, checkTimeoutSeconds: 1 };
  const started = Date.now();
  const r = await verifyTask(t);
  assert.equal(r.solutionPasses, false);
  assert.ok(Date.now() - started < 8000);
});
