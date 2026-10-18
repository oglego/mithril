import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import net, { type AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchLlamafile, stopAll } from "./backend.js";
import { ConfigError } from "./config.js";
import { EXIT, runHeadless, type HeadlessIO } from "./headless.js";

// These tests start a fake llamafile: a shell script that runs a tiny fake
// llama-server, started the way the real thing is (`sh <file> --server --port N ...`).
// They are about the lifecycle: the model server must be up while it is needed
// and gone afterwards, however Mithril ends.

const posix = process.platform !== "win32";
const LAUNCHER = fileURLToPath(new URL("../bin/mithril.mjs", import.meta.url));

const FAKE_SERVER = `
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
fs.writeFileSync(path.join(dir, "args.json"), JSON.stringify(args));
const behavior = JSON.parse(fs.readFileSync(path.join(dir, "behavior.json"), "utf-8"));
if (behavior.mode === "crash") process.exit(3);
if (behavior.mode === "hang") {
  setInterval(() => {}, 1000); // alive but never ready
} else {
  const nctx = Number(flag("-c") ?? 8192);
  http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end('{"status":"ok"}');
    if (req.url === "/props") return res.end(JSON.stringify({ default_generation_settings: { n_ctx: nctx } }));
    if (req.url === "/v1/models") return res.end('{"data":[{"id":"fake"}]}');
    req.resume();
    req.on("end", () => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "fake answer" } }], usage: { prompt_tokens: 12, completion_tokens: 3 } })));
  }).listen(Number(flag("--port")), "127.0.0.1");
}
`;

interface Fake {
  dir: string;
  llamafile: string;
  pid: () => number | undefined;
  args: () => string[];
}

async function withFake<T>(mode: "ok" | "crash" | "hang", fn: (fake: Fake) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fake-llamafile-"));
  writeFileSync(path.join(dir, "server.mjs"), FAKE_SERVER);
  writeFileSync(path.join(dir, "behavior.json"), JSON.stringify({ mode }));
  const llamafile = path.join(dir, "Fake-Model-Q8_0.llamafile");
  writeFileSync(llamafile, `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, "server.mjs")}" "$@"\n`);
  chmodSync(llamafile, 0o755);

  // The manager writes ./mithril.log; keep that out of the repository.
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    return await fn({
      dir,
      llamafile,
      pid: () => (existsSync(path.join(dir, "pid")) ? Number(readFileSync(path.join(dir, "pid"), "utf-8")) : undefined),
      args: () => (existsSync(path.join(dir, "args.json")) ? (JSON.parse(readFileSync(path.join(dir, "args.json"), "utf-8")) as string[]) : []),
    });
  } finally {
    stopAll();
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function answers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

// A killed-but-not-yet-reaped process still answers kill(pid, 0) but is dead.
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf-8" }).trim();
    return stat !== "" && !stat.startsWith("Z");
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIO = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    readStdin: async () => "",
    stdinIsTTY: false,
    env: {},
  };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

// ---------- launchLlamafile ----------

test("launchLlamafile starts the file on the requested port and reports its context window", { skip: !posix }, async () => {
  await withFake("ok", async (fake) => {
    const port = await freePort();
    const statuses: string[] = [];
    const started = await launchLlamafile({
      binaryPath: fake.llamafile,
      modelId: "Fake-Model-Q8_0.llamafile",
      port,
      contextFlag: undefined,
      onStatus: (m) => statuses.push(m),
    });
    assert.deepEqual(started.chatConfig, { baseUrl: `http://localhost:${port}`, model: "Fake-Model-Q8_0.llamafile" });
    assert.equal(started.contextWindow.window, 8192, "detected from the server");
    assert.ok(statuses.some((m) => /ready/.test(m)));
    assert.deepEqual(fake.args().slice(0, 3), ["--server", "--port", String(port)]);
    assert.ok(fake.args().includes("--jinja") && fake.args().includes("--no-webui"));
    assert.ok(!fake.args().includes("-c"), "no -c unless a window was asked for");
    assert.equal(await answers(port), true);

    stopAll();
    assert.equal(await waitUntil(async () => !(await answers(port)), 5000), true, "the server must be gone after stopAll");
  });
});

test("launchLlamafile passes --context to the server as -c and uses it as the window", { skip: !posix }, async () => {
  await withFake("ok", async (fake) => {
    const port = await freePort();
    const started = await launchLlamafile({ binaryPath: fake.llamafile, modelId: "m", port, contextFlag: 4096, onStatus: () => {} });
    const args = fake.args();
    assert.equal(args[args.indexOf("-c") + 1], "4096");
    assert.equal(started.contextWindow.window, 4096);
  });
});

test("launchLlamafile reports a missing file as a configuration error that names it", async () => {
  await assert.rejects(
    launchLlamafile({ binaryPath: "/no/such/model.llamafile", modelId: "m", port: 18999, contextFlag: undefined, onStatus: () => {} }),
    (err: unknown) => err instanceof ConfigError && /no such file: \/no\/such\/model\.llamafile/.test(err.message)
  );
});

test("a directory is not a llamafile", async () => {
  await assert.rejects(
    launchLlamafile({ binaryPath: os.tmpdir(), modelId: "m", port: 18998, contextFlag: undefined, onStatus: () => {} }),
    ConfigError
  );
});

// ---------- headless mode ----------

test("headless --llamafile: starts the model, answers, and stops the model", { skip: !posix }, async () => {
  await withFake("ok", async (fake) => {
    const port = await freePort();
    const c = capture();
    const code = await runHeadless(["-p", "hello", "--llamafile", fake.llamafile, "--port", String(port)], c.io);
    assert.equal(code, EXIT.OK, c.stderr());
    assert.equal(c.stdout(), "fake answer\n", "stdout is only the answer");
    assert.match(c.stderr(), /chat model is ready/, "startup progress goes to stderr");
    assert.equal(await waitUntil(async () => !(await answers(port)), 5000), true, "the model server must be stopped when the run ends");
  });
});

test("headless --llamafile with json output keeps the model name and token usage", { skip: !posix }, async () => {
  await withFake("ok", async (fake) => {
    const port = await freePort();
    const c = capture();
    const code = await runHeadless(["-p", "hello", "--llamafile", fake.llamafile, "--port", String(port), "--output-format", "json"], c.io);
    assert.equal(code, EXIT.OK);
    const r = JSON.parse(c.stdout()) as Record<string, any>;
    assert.equal(r.ok, true);
    assert.equal(r.model, "Fake-Model-Q8_0.llamafile");
    assert.deepEqual(r.usage, { prompt_tokens: 12, completion_tokens: 3 });
  });
});

test("headless --llamafile: a model that dies on startup is a failure that points at the log, and nothing is left running", { skip: !posix }, async () => {
  await withFake("crash", async (fake) => {
    const port = await freePort();
    const c = capture();
    const code = await runHeadless(["-p", "hello", "--llamafile", fake.llamafile, "--port", String(port)], c.io);
    assert.equal(code, EXIT.FAILED);
    assert.equal(c.stdout(), "");
    assert.match(c.stderr(), /before becoming ready/);
    assert.match(c.stderr(), /mithril\.log/);
    assert.equal(await answers(port), false);
  });
});

test("headless --llamafile: a missing file is a usage error", async () => {
  const c = capture();
  const code = await runHeadless(["-p", "hello", "--llamafile", "/no/such/model.llamafile"], c.io);
  assert.equal(code, EXIT.USAGE);
  assert.match(c.stderr(), /no such file/);
  assert.equal(c.stdout(), "");
});

test("headless --llamafile with --base-url is a usage error, not a silent choice", async () => {
  const c = capture();
  const code = await runHeadless(["-p", "hello", "--llamafile", "m.llamafile", "--base-url", "http://x", "--model", "m"], c.io);
  assert.equal(code, EXIT.USAGE);
  assert.match(c.stderr(), /can't be combined/);
});

test("headless --llamafile: a port that is already taken is reported, not mistaken for our server", { skip: !posix }, async () => {
  await withFake("ok", async (fake) => {
    const blocker = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    const port = (blocker.address() as AddressInfo).port;
    try {
      const c = capture();
      const code = await runHeadless(["-p", "hello", "--llamafile", fake.llamafile, "--port", String(port)], c.io);
      assert.equal(code, EXIT.FAILED);
      assert.match(c.stderr(), /already in use/);
      assert.equal(fake.pid(), undefined, "the model must not have been started");
    } finally {
      blocker.close();
    }
  });
});

test("without any model flags headless explains the options instead of opening the picker", async () => {
  const c = capture();
  const code = await runHeadless(["-p", "hello"], c.io);
  assert.equal(code, EXIT.USAGE);
  assert.match(c.stderr(), /--llamafile <path>.*--base-url/);
});

// ---------- the real command ----------

function runCli(args: string[], opts: { onChild?: (child: ReturnType<typeof spawn>) => void } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("MITHRIL_") || key === "OPENAI_API_KEY") delete env[key];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    opts.onChild?.(child);
  });
}

test("the mithril command runs a task against a llamafile and leaves nothing running", { skip: !posix }, async () => {
  await withFake("ok", async (fake) => {
    const port = await freePort();
    const r = await runCli(["-p", "hello", "--llamafile", fake.llamafile, "--port", String(port)]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "fake answer\n");
    const pid = fake.pid();
    assert.ok(pid, "the fake model was started");
    assert.equal(await waitUntil(() => !isRunning(pid!), 5000), true, "the model process outlived the command");
    assert.equal(await answers(port), false);
  });
});

test("Ctrl+C while the model is still starting exits 130 and stops the model", { skip: !posix }, async () => {
  await withFake("hang", async (fake) => {
    const port = await freePort();
    const result = runCli(["-p", "hello", "--llamafile", fake.llamafile, "--port", String(port)], {
      onChild: (child) => {
        // Interrupt once the model process exists but will never become ready.
        void waitUntil(() => fake.pid() !== undefined, 20_000).then(() => setTimeout(() => child.kill("SIGINT"), 300));
      },
    });
    const r = await result;
    assert.equal(r.code, 130, r.stderr);
    const pid = fake.pid();
    assert.ok(pid);
    assert.equal(await waitUntil(() => !isRunning(pid!), 5000), true, "the model process was left running after Ctrl+C");
  });
});

test("eval accepts --llamafile and reports a missing file as a usage error", { skip: !posix }, async () => {
  const r = await runCli(["eval", "--llamafile", "/no/such/model.llamafile", "--task", "fix-off-by-one", "--runs", "1"]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr + r.stdout, /no such file/);
});

test("the command works through a symlink from another directory, as `npm link` runs it", { skip: !posix }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mithril-link-"));
  try {
    const link = path.join(dir, "mithril");
    symlinkSync(LAUNCHER, link);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("MITHRIL_") || key === "OPENAI_API_KEY") delete env[key];
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [link, "-p", "--help"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout!.on("data", (d) => (stdout += d));
      child.on("close", (code) => resolve({ code, stdout }));
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: mithril -p/);
    assert.match(result.stdout, /--llamafile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
