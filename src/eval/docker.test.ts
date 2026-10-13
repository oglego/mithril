import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "eval-docker.sh");
const posix = process.platform !== "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const scratch: string[] = [];
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "mithril-docker-"));
  scratch.push(d);
  return d;
}

// The host's own settings must never leak into these tests.
const baseEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) if (key.startsWith("MITHRIL_") || key === "OPENAI_API_KEY") delete baseEnv[key];

function run(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf-8",
    env: { ...baseEnv, MITHRIL_EVAL_DRY_RUN: "1", ...env },
    ...(cwd ? { cwd } : {}),
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

// Dry-run prints one shell-quoted command line; `\,` is bash's quoting of a comma.
function tokens(out: string): string[] {
  return out.trim().replace(/\\,/g, ",").split(/\s+/);
}
function pair(toks: string[], flag: string): string | undefined {
  const i = toks.indexOf(flag);
  return i === -1 ? undefined : toks[i + 1];
}

const MODEL = ["--base-url", "https://api.example.com", "--model", "m"];

test("scripts/eval-docker.sh is executable and has valid bash syntax", { skip: !posix }, () => {
  assert.ok(statSync(SCRIPT).mode & 0o111, "must be executable");
  assert.equal(spawnSync("bash", ["-n", SCRIPT]).status, 0);
});

test("shellcheck finds nothing to complain about (when installed)", { skip: !posix }, (t) => {
  if (spawnSync("shellcheck", ["--version"]).status !== 0) return t.skip("shellcheck is not installed");
  const r = spawnSync("shellcheck", [SCRIPT], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stdout);
});

// ---- the docker command that would run ----

test("the container is locked down", { skip: !posix }, () => {
  const { status, out } = run([...MODEL]);
  assert.equal(status, 0);
  const t = tokens(out);
  assert.equal(t[0], "docker");
  assert.equal(t[1], "run");
  assert.ok(t.includes("--rm"));
  assert.ok(t.includes("--read-only"), "read-only root filesystem");
  assert.equal(pair(t, "--tmpfs"), "/tmp:rw,size=512m");
  assert.equal(pair(t, "--cap-drop"), "ALL");
  assert.equal(pair(t, "--security-opt"), "no-new-privileges");
  assert.equal(pair(t, "--pids-limit"), "256");
  assert.equal(pair(t, "--memory"), "1g");
  assert.equal(pair(t, "--cpus"), "1");
  assert.equal(pair(t, "--user"), `${process.getuid!()}:${process.getgid!()}`, "runs as the invoking user, not root");
  assert.ok(!t.includes("--privileged"));
  assert.ok(!t.includes("--network=host") && pair(t, "--network") !== "host");
});

test("only the results directory (absolute path) is mounted from the host", { skip: !posix }, () => {
  const cwd = tmp();
  const t = tokens(run([...MODEL], {}, cwd).out);
  const mounts = t.flatMap((x, i) => (x === "-v" ? [t[i + 1]!] : []));
  assert.deepEqual(mounts, [`${realpathSync(cwd)}/eval-results:/results`]);

  const custom = tokens(run([...MODEL], { MITHRIL_EVAL_RESULTS: "/data/out" }).out);
  assert.equal(pair(custom, "-v"), "/data/out:/results");
  const relative = tokens(run([...MODEL], { MITHRIL_EVAL_RESULTS: "./runs" }, cwd).out);
  assert.equal(pair(relative, "-v"), `${realpathSync(cwd)}/runs:/results`);
});

test("eval arguments pass through in order, followed by --out /results", { skip: !posix }, () => {
  const t = tokens(run([...MODEL, "--runs", "3", "--label", "baseline", "--temperature", "0.2"]).out);
  const tail = t.slice(t.indexOf("mithril-eval") + 1);
  assert.deepEqual(tail, ["--base-url", "https://api.example.com", "--model", "m", "--runs", "3", "--label", "baseline", "--temperature", "0.2", "--out", "/results"]);
});

test("limits and image name are configurable", { skip: !posix }, () => {
  const t = tokens(run([...MODEL], { MITHRIL_EVAL_MEMORY: "4g", MITHRIL_EVAL_CPUS: "2", MITHRIL_EVAL_IMAGE: "my-eval" }).out);
  assert.equal(pair(t, "--memory"), "4g");
  assert.equal(pair(t, "--cpus"), "2");
  assert.ok(t.includes("my-eval"));
});

// ---- reaching a model server on the host ----

test("loopback URLs are rewritten to host.docker.internal, with a note and the host mapping", { skip: !posix }, () => {
  const cases: [string, string][] = [
    ["http://localhost:11434", "http://host.docker.internal:11434"],
    ["http://localhost", "http://host.docker.internal"],
    ["http://127.0.0.1:8080/v1", "http://host.docker.internal:8080/v1"],
    ["https://localhost:9000", "https://host.docker.internal:9000"],
    ["http://[::1]:11434", "http://host.docker.internal:11434"],
  ];
  for (const [from, to] of cases) {
    const r = run(["--base-url", from, "--model", "m"]);
    const t = tokens(r.out);
    assert.equal(pair(t, "--base-url"), to, from);
    assert.equal(pair(t, "--add-host"), undefined);
    assert.ok(t.includes("--add-host=host.docker.internal:host-gateway"), from);
    assert.match(r.err, /non-loopback address/);
  }
});

test("other URLs are left alone, including hostnames that merely start with localhost", { skip: !posix }, () => {
  for (const url of ["https://api.openai.com", "http://192.168.1.20:11434", "http://localhost.example.com:80", "http://modelserver:11434"]) {
    const r = run(["--base-url", url, "--model", "m"]);
    assert.equal(pair(tokens(r.out), "--base-url"), url);
    assert.doesNotMatch(r.err, /non-loopback/);
  }
});

test("a custom network replaces the host mapping and disables URL rewriting", { skip: !posix }, () => {
  const r = run(["--base-url", "http://localhost:11434", "--model", "m"], { MITHRIL_EVAL_NETWORK: "evalnet" });
  const t = tokens(r.out);
  assert.equal(pair(t, "--network"), "evalnet");
  assert.ok(!t.some((x) => x.startsWith("--add-host")));
  assert.equal(pair(t, "--base-url"), "http://localhost:11434");
});

// ---- custom tasks ----

test("--tasks is mounted read-only and the path is translated", { skip: !posix }, () => {
  const dir = tmp();
  const t = tokens(run([...MODEL, "--tasks", dir]).out);
  assert.equal(pair(t, "--tasks"), "/tasks");
  assert.ok(t.includes(`${realpathSync(dir)}:/tasks:ro`));
  assert.ok(!t.includes(dir) || realpathSync(dir) === dir ? true : !t.includes(dir + " "));
});

test("--tasks with a missing directory or no value is refused", { skip: !posix }, () => {
  assert.match(run([...MODEL, "--tasks", "/no/such/dir"]).err, /tasks directory not found/);
  assert.match(run([...MODEL, "--tasks"]).err, /--tasks needs a value/);
});

// ---- secrets ----

test("API keys are forwarded by name only, never by value", { skip: !posix }, () => {
  const secret = "sk-very-secret-value-123";
  const r = run([...MODEL], { MITHRIL_API_KEY: secret, OPENAI_API_KEY: secret + "-2" });
  const t = tokens(r.out);
  assert.deepEqual(t.flatMap((x, i) => (x === "-e" ? [t[i + 1]] : [])), ["MITHRIL_API_KEY", "OPENAI_API_KEY"]);
  assert.ok(!r.out.includes(secret) && !r.err.includes(secret), "the secret must not appear in any output");
  assert.match(r.err, /forwarding MITHRIL_API_KEY/);
  assert.match(r.err, /throwaway key/);
});

test("no key in the environment means nothing is forwarded", { skip: !posix }, () => {
  const r = run([...MODEL]);
  assert.ok(!tokens(r.out).includes("-e"));
  assert.doesNotMatch(r.err, /forwarding/);
});

// ---- refusals ----

test("options that don't make sense in a container are refused with an explanation", { skip: !posix }, () => {
  const cases: [string[], RegExp][] = [
    [[...MODEL, "--out", "x"], /--out is set by this script.*MITHRIL_EVAL_RESULTS/],
    [[...MODEL, "--compare", "a.json", "b.json"], /needs no container/],
    [[...MODEL, "--keep-workdirs"], /disappear when it exits/],
    [["--runs", "3"], /pass --base-url and --model/],
    [["--base-url"], /--base-url needs a value/],
  ];
  for (const [args, pattern] of cases) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.err, /^eval-docker: /);
    assert.match(r.err, pattern);
    assert.equal(r.out, "", "nothing may run after a refusal");
  }
});

test("--help, --list and --verify-tasks don't need a model", { skip: !posix }, () => {
  for (const flag of ["--help", "--list", "--verify-tasks"]) {
    const r = run([flag]);
    assert.equal(r.status, 0, flag);
    assert.ok(tokens(r.out).includes(flag));
  }
});

test("without Docker installed the script says so and exits 2", { skip: !posix }, () => {
  const r = spawnSync("/bin/bash", [SCRIPT, ...MODEL], { encoding: "utf-8", env: { PATH: "/nonexistent" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /docker was not found/);
});

// ---- the real (non-dry-run) flow, against a fake docker ----

function fakeDocker(exists: boolean, runExit = 0): { dir: string; log: string } {
  const dir = tmp();
  const log = path.join(dir, "calls.log");
  writeFileSync(
    path.join(dir, "docker"),
    `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "image" ]; then exit ${exists ? 0 : 1}; fi
if [ "$1" = "run" ]; then exit ${runExit}; fi
exit 0
`
  );
  chmodSync(path.join(dir, "docker"), 0o755);
  return { dir, log };
}

function runReal(args: string[], docker: { dir: string }, env: Record<string, string> = {}, cwd?: string) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf-8",
    env: { ...baseEnv, PATH: `${docker.dir}:${process.env.PATH}`, ...env },
    ...(cwd ? { cwd } : {}),
  });
  return { status: r.status, err: r.stderr };
}

const calls = (log: string) => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n") : []);

test("real run: builds the image when missing, then runs the container", { skip: !posix || isRoot }, () => {
  const docker = fakeDocker(false);
  const cwd = tmp();
  const r = runReal([...MODEL], docker, {}, cwd);
  assert.equal(r.status, 0, r.err);
  const log = calls(docker.log);
  assert.equal(log.length, 3);
  assert.match(log[0]!, /^image inspect mithril-eval$/);
  assert.match(log[1]!, new RegExp(`^build -t mithril-eval ${ROOT.replace(/[/\\]$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(log[2]!, /^run --rm --read-only /);
  assert.match(log[2]!, / mithril-eval --base-url https:\/\/api\.example\.com --model m --out \/results$/);
  assert.ok(existsSync(path.join(cwd, "eval-results")), "the results directory is created on the host");
});

test("real run: an existing image is not rebuilt, unless asked", { skip: !posix || isRoot }, () => {
  const docker = fakeDocker(true);
  runReal([...MODEL], docker, {}, tmp());
  assert.deepEqual(calls(docker.log).map((l) => l.split(" ")[0]), ["image", "run"]);

  const again = fakeDocker(true);
  runReal([...MODEL], again, { MITHRIL_EVAL_REBUILD: "1" }, tmp());
  // Rebuilding unconditionally, so it never needs to ask whether the image exists.
  assert.deepEqual(calls(again.log).map((l) => l.split(" ")[0]), ["build", "run"]);
});

test("real run: the container's exit code becomes the script's exit code", { skip: !posix || isRoot }, () => {
  assert.equal(runReal([...MODEL], fakeDocker(true, 7), {}, tmp()).status, 7);
});

test("real run: refuses to run as root", { skip: !posix || !isRoot }, () => {
  const r = spawnSync("bash", [SCRIPT, ...MODEL], { encoding: "utf-8", env: { ...baseEnv, PATH: `${fakeDocker(true).dir}:${process.env.PATH}` } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing to run as root/);
});

// ---- the image definition ----

test("the Dockerfile builds an unprivileged, read-only-friendly image on a supported Node", { skip: !posix }, () => {
  const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf-8");
  const node = /^FROM node:(\d+)/m.exec(dockerfile);
  assert.ok(node, "FROM node:<major>");
  const engines = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8")).engines.node as string;
  assert.ok(Number(node![1]) >= Number(/(\d+)/.exec(engines)![1]), `base image Node ${node![1]} must satisfy engines ${engines}`);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^ENV HOME=\/tmp$/m);
  assert.match(dockerfile, /ENTRYPOINT \["node", "--import", "tsx", "src\/index\.ts", "eval"\]/);
  const instructions = dockerfile.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(instructions, /npx/, "npx needs a writable home directory");
});

test(".dockerignore keeps models, secrets and results out of the build context", { skip: !posix }, () => {
  const lines = readFileSync(path.join(ROOT, ".dockerignore"), "utf-8").split("\n").map((l) => l.trim());
  for (const entry of ["node_modules", "models", "eval-results", ".git", ".env"]) assert.ok(lines.includes(entry), `.dockerignore must list ${entry}`);
});

test("the files the Dockerfile copies exist", { skip: !posix }, () => {
  for (const f of ["package.json", "package-lock.json", "src/index.ts", "eval-tasks/_lib.mjs"]) assert.ok(existsSync(path.join(ROOT, f)), f);
  mkdirSync(path.join(tmp(), "x"), { recursive: true });
});
