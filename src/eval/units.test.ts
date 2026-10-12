import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkCommand } from "./policy.js";
import { wilsonInterval, mean, intervalsOverlap } from "./stats.js";
import {
  TaskError, loadTask, loadTasks, selectTasks, snapshotDir, changedFiles, createWorkdir, applySolution,
} from "./tasks.js";

const scratch: string[] = [];
after(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "mithril-units-"));
  scratch.push(d);
  return d;
}

// ---- command policy ----

test("policy allows plain invocations of allowed programs", () => {
  for (const cmd of ["node --test", "node src/main.mjs", "  node   a.mjs  ", "/usr/local/bin/node x.mjs"]) {
    assert.equal(checkCommand(cmd, ["node"]).allowed, true, cmd);
  }
});

test("policy refuses other programs and anything that chains or redirects", () => {
  const refused = [
    "rm -rf src", "curl http://example.com", "npm test", "FOO=1 node a.mjs", "",
    "node a.mjs; rm -rf /", "node a.mjs && echo hi", "node a.mjs || true", "node a.mjs | cat",
    "node a.mjs > out.txt", "node a.mjs < in.txt", "node $(whoami)", "node `whoami`",
    "node a.mjs\nrm x", "node (a)", "node a.mjs &",
  ];
  for (const cmd of refused) assert.equal(checkCommand(cmd, ["node"]).allowed, false, JSON.stringify(cmd));
});

test("policy gives a reason, and honours a task's own allow-list", () => {
  assert.match(checkCommand("npm test", ["node"]).reason ?? "", /not in this task's allowed commands/);
  assert.match(checkCommand("node a; b", ["node"]).reason ?? "", /shell operators/);
  assert.equal(checkCommand("npm test", ["node", "npm"]).allowed, true);
});

// ---- statistics ----

const close = (a: number, b: number, eps = 0.001) => assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

test("wilson interval matches known values", () => {
  const none = wilsonInterval(0, 10);
  close(none.low, 0); close(none.high, 0.2775);
  const all = wilsonInterval(10, 10);
  close(all.low, 0.7225); close(all.high, 1);
  const half = wilsonInterval(5, 10);
  close(half.low, 0.2366); close(half.high, 0.7634);
});

test("wilson interval stays within [0,1] and is honest about tiny samples", () => {
  assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 1 });
  const one = wilsonInterval(1, 1);
  assert.ok(one.low > 0.2 && one.low < 0.3, "1 success in 1 trial must not look like certainty");
  assert.equal(one.high, 1);
  for (let n = 1; n <= 40; n++) {
    for (let k = 0; k <= n; k++) {
      const { low, high } = wilsonInterval(k, n);
      assert.ok(low >= 0 && high <= 1 && low <= k / n + 1e-9 && high >= k / n - 1e-9, `${k}/${n}`);
    }
  }
});

test("wilson intervals narrow as the sample grows", () => {
  const small = wilsonInterval(7, 10), large = wilsonInterval(70, 100);
  assert.ok(large.high - large.low < small.high - small.low);
});

test("mean and overlap helpers", () => {
  assert.equal(mean([]), null);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(intervalsOverlap({ low: 0, high: 0.5 }, { low: 0.4, high: 1 }), true);
  assert.equal(intervalsOverlap({ low: 0, high: 0.3 }, { low: 0.4, high: 1 }), false);
});

// ---- task loading ----

async function writeTask(root: string, id: string, json: unknown, opts: { fixture?: boolean; check?: boolean } = {}): Promise<string> {
  const dir = path.join(root, id);
  await mkdir(path.join(dir, "fixture"), { recursive: true });
  if (opts.fixture === false) await rm(path.join(dir, "fixture"), { recursive: true });
  if (opts.check !== false) await writeFile(path.join(dir, "check.mjs"), "process.exit(0)");
  await writeFile(path.join(dir, "task.json"), typeof json === "string" ? json : JSON.stringify(json));
  return dir;
}
const valid = (id: string) => ({ id, title: "A task", prompt: "Do the thing." });

test("loadTask applies defaults", async () => {
  const root = await tmp();
  const t = await loadTask(await writeTask(root, "a", valid("a")));
  assert.deepEqual(
    { type: t.type, maxSteps: t.maxSteps, timeoutSeconds: t.timeoutSeconds, checkTimeoutSeconds: t.checkTimeoutSeconds, allowed: t.allowedCommands },
    { type: "edit", maxSteps: 15, timeoutSeconds: 300, checkTimeoutSeconds: 30, allowed: ["node"] }
  );
});

test("loadTask rejects malformed tasks with a message naming the task", async () => {
  const root = await tmp();
  const cases: [string, unknown, RegExp, { fixture?: boolean; check?: boolean }?][] = [
    ["wrong-id", { ...valid("other") }, /"id" must equal the directory name/],
    ["no-prompt", { id: "no-prompt", title: "t" }, /"prompt" is required/],
    ["blank-prompt", { id: "blank-prompt", title: "t", prompt: "  " }, /"prompt" is required/],
    ["no-title", { id: "no-title", prompt: "p" }, /"title" is required/],
    ["bad-type", { ...valid("bad-type"), type: "essay" }, /"type" must be/],
    ["bad-steps", { ...valid("bad-steps"), max_steps: 0 }, /max_steps must be a positive whole number/],
    ["frac-timeout", { ...valid("frac-timeout"), timeout_seconds: 1.5 }, /timeout_seconds/],
    ["bad-cmds", { ...valid("bad-cmds"), allowed_commands: "node" }, /allowed_commands/],
    ["no-fixture", valid("no-fixture"), /missing fixture/, { fixture: false }],
    ["no-check", valid("no-check"), /missing check\.mjs/, { check: false }],
    ["not-json", "{ nope", /cannot read task\.json/],
  ];
  for (const [id, json, pattern, opts] of cases) {
    const dir = await writeTask(root, id, json, opts);
    await assert.rejects(() => loadTask(dir), (e: unknown) => e instanceof TaskError && pattern.test(e.message) && e.message.includes(id), id);
  }
});

test("loadTasks skips helper files and directories starting with _ or .", async () => {
  const root = await tmp();
  await writeTask(root, "real", valid("real"));
  await writeFile(path.join(root, "_lib.mjs"), "export {}");
  await mkdir(path.join(root, "_shared"));
  await mkdir(path.join(root, ".hidden"));
  assert.deepEqual((await loadTasks(root)).map((t) => t.id), ["real"]);
});

test("loadTasks errors clearly on an empty or missing directory", async () => {
  await assert.rejects(() => loadTasks(path.join(os.tmpdir(), "does-not-exist-xyz")), /Cannot read tasks directory/);
  const empty = await tmp();
  await assert.rejects(() => loadTasks(empty), /No tasks found/);
});

test("selectTasks keeps the requested order and names unknown ids", async () => {
  const root = await tmp();
  for (const id of ["a", "b", "c"]) await writeTask(root, id, valid(id));
  const all = await loadTasks(root);
  assert.deepEqual(selectTasks(all, ["c", "a"]).map((t) => t.id), ["c", "a"]);
  assert.equal(selectTasks(all, undefined).length, 3);
  assert.throws(() => selectTasks(all, ["a", "zzz"]), /Unknown task\(s\): zzz\. Available: a, b, c/);
});

test("snapshots detect modified, added and removed files", async () => {
  const dir = await tmp();
  await mkdir(path.join(dir, "sub"));
  await writeFile(path.join(dir, "keep.txt"), "same");
  await writeFile(path.join(dir, "edit.txt"), "before");
  await writeFile(path.join(dir, "sub", "gone.txt"), "x");
  const before = await snapshotDir(dir);
  await writeFile(path.join(dir, "edit.txt"), "after");
  await writeFile(path.join(dir, "new.txt"), "n");
  await rm(path.join(dir, "sub", "gone.txt"));
  assert.deepEqual(changedFiles(before, await snapshotDir(dir)), ["edit.txt", "new.txt", "sub/gone.txt"]);
  assert.deepEqual(changedFiles(before, before), []);
});

test("createWorkdir copies the fixture and keeps the reply file outside it", async () => {
  const root = await tmp();
  const dir = await writeTask(root, "w", valid("w"));
  await writeFile(path.join(dir, "fixture", "f.txt"), "hello");
  const task = await loadTask(dir);
  const w = await createWorkdir(task);
  try {
    assert.deepEqual([...(await snapshotDir(w.workdir)).keys()], ["f.txt"]);
    assert.ok(!w.replyFile.startsWith(w.workdir + path.sep), "the agent must not be able to see the reply file");
  } finally {
    await w.cleanup();
  }
});

test("applySolution overlays files and returns the reference reply", async () => {
  const root = await tmp();
  const dir = await writeTask(root, "s", { ...valid("s"), type: "answer" });
  await mkdir(path.join(dir, "solution"));
  await writeFile(path.join(dir, "solution", "reply.txt"), "the answer");
  const task = await loadTask(dir);
  const w = await createWorkdir(task);
  try {
    assert.equal(await applySolution(task, w.workdir), "the answer");
    assert.deepEqual([...(await snapshotDir(w.workdir)).keys()], [], "reply.txt is not copied into the project");
  } finally {
    await w.cleanup();
  }
});

test("an answer task without solution/reply.txt is rejected", async () => {
  const root = await tmp();
  const dir = await writeTask(root, "r", { ...valid("r"), type: "answer" });
  await mkdir(path.join(dir, "solution"));
  const task = await loadTask(dir);
  const w = await createWorkdir(task);
  try {
    await assert.rejects(() => applySolution(task, w.workdir), /needs solution\/reply\.txt/);
  } finally {
    await w.cleanup();
  }
});
