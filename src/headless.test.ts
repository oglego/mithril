import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError } from "./config.js";
import {
  EXIT,
  buildHeadlessTools,
  exitCodeFor,
  newFileTracker,
  parseHeadlessArgs,
  runHeadless,
  type HeadlessIO,
} from "./headless.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";

// ---------- argument parsing ----------

test("defaults: read-only, text output, no limits", () => {
  const o = parseHeadlessArgs(["-p", "explain this"]);
  assert.equal(o.prompt, "explain this");
  assert.equal(o.outputFormat, "text");
  assert.equal(o.allowWrite, false);
  assert.deepEqual(o.allowCommands, []);
  assert.equal(o.maxSteps, 15);
  assert.equal(o.timeoutSeconds, undefined);
});

test("-p and --print are the same; no value or '-' means read stdin", () => {
  assert.equal(parseHeadlessArgs(["--print", "hi"]).prompt, "hi");
  assert.equal(parseHeadlessArgs(["-p"]).prompt, undefined);
  assert.equal(parseHeadlessArgs(["-p", "-"]).prompt, undefined);
  assert.equal(parseHeadlessArgs(["-p", "--allow-write"]).prompt, undefined);
});

test("--allow-command takes program names, repeated and/or comma separated", () => {
  const o = parseHeadlessArgs(["-p", "x", "--allow-command", "node,npm", "--allow-command", "git", "--allow-command", "node"]);
  assert.deepEqual(o.allowCommands, ["node", "npm", "git"]);
});

test("--allow-command rejects full commands, paths and wildcards", () => {
  for (const bad of ["npm test", "./run.sh", "*", "rm;ls"]) {
    assert.throws(() => parseHeadlessArgs(["-p", "x", "--allow-command", bad]), /program names/, bad);
  }
});

test("typos and unquoted prompts are errors, not silently ignored", () => {
  assert.throws(() => parseHeadlessArgs(["-p", "x", "--allow-writes"]), /Unknown option --allow-writes/);
  assert.throws(() => parseHeadlessArgs(["-p", "fix", "the", "bug"]), /Unexpected argument "the".*quotes/);
  assert.throws(() => parseHeadlessArgs(["-p", "x", "--docs", "d"]), /not supported in headless/);
});

test("numeric flags are validated", () => {
  assert.throws(() => parseHeadlessArgs(["-p", "x", "--max-steps", "0"]), /--max-steps/);
  assert.throws(() => parseHeadlessArgs(["-p", "x", "--max-steps", "2.5"]), /--max-steps/);
  assert.throws(() => parseHeadlessArgs(["-p", "x", "--timeout", "-3"]), /--timeout/);
  assert.throws(() => parseHeadlessArgs(["-p", "x", "--temperature", "9"]), /--temperature/);
  assert.throws(() => parseHeadlessArgs(["-p", "x", "--output-format", "xml"]), /text.*json/);
  assert.throws(() => parseHeadlessArgs(["-p", "x", "--timeout"]), /needs a value/);
  const o = parseHeadlessArgs(["-p", "x", "--max-steps", "40", "--timeout", "0.5", "--temperature", "0"]);
  assert.deepEqual([o.maxSteps, o.timeoutSeconds, o.temperature], [40, 0.5, 0]);
});

test("errors are ConfigErrors so they map to the usage exit code", () => {
  assert.throws(() => parseHeadlessArgs(["-p", "x", "--bogus"]), ConfigError);
});

// ---------- exit codes ----------

test("stop reasons map to distinct exit codes", () => {
  assert.equal(exitCodeFor("answered", false), EXIT.OK);
  assert.equal(exitCodeFor("max_steps", false), EXIT.MAX_STEPS);
  assert.equal(exitCodeFor("server_error", false), EXIT.FAILED);
  assert.equal(exitCodeFor("context", false), EXIT.FAILED);
  assert.equal(exitCodeFor("aborted", true), EXIT.TIMEOUT);
  assert.equal(exitCodeFor("aborted", false), EXIT.INTERRUPTED);
});

// ---------- system prompt ----------

test("the headless system prompt tells the model nobody can answer; the normal one doesn't", () => {
  const tools = buildHeadlessTools({ allowWrite: false, allowCommands: [] }, newFileTracker());
  assert.match(buildSystemPrompt(tools, { headless: true }), /non-interactive/);
  assert.doesNotMatch(buildSystemPrompt(tools), /non-interactive/);
});

// ---------- fixtures ----------

function withProject<T>(files: Record<string, string>, fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mithril-headless-"));
  // A package.json marks the project root, like a real project would have.
  writeFileSync(path.join(root, "package.json"), "{}");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  const previous = process.env.MITHRIL_PROJECT_ROOT;
  process.env.MITHRIL_PROJECT_ROOT = root;
  return fn(root).finally(() => {
    if (previous === undefined) delete process.env.MITHRIL_PROJECT_ROOT;
    else process.env.MITHRIL_PROJECT_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

interface Reply {
  text?: string;
  tools?: { name: string; args: Record<string, unknown> }[];
  status?: number;
  delayMs?: number;
}
interface SeenRequest {
  messages: { role: string; content?: string }[];
  toolNames: string[];
  headers: IncomingHttpHeaders;
}

// A fake OpenAI-compatible server. `script(n)` says how to answer the n-th chat request.
async function withModel(
  script: (n: number) => Reply,
  fn: (baseUrl: string, seen: SeenRequest[]) => Promise<void>
): Promise<void> {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: SeenRequest["messages"]; tools?: { function: { name: string } }[] };
      seen.push({ messages: parsed.messages, toolNames: (parsed.tools ?? []).map((t) => t.function.name), headers: req.headers });
      const reply = script(seen.length);
      setTimeout(() => {
        if (reply.status) {
          res.statusCode = reply.status;
          res.end("boom");
          return;
        }
        res.setHeader("Content-Type", "application/json");
        const message = reply.tools
          ? {
              role: "assistant",
              content: null,
              tool_calls: reply.tools.map((t, i) => ({
                id: `call_${seen.length}_${i}`,
                type: "function",
                function: { name: t.name, arguments: JSON.stringify(t.args) },
              })),
            }
          : { role: "assistant", content: reply.text ?? "" };
        res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function capture(opts: { env?: Record<string, string>; stdin?: string; tty?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIO = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    readStdin: async () => opts.stdin ?? "",
    stdinIsTTY: opts.tty ?? false,
    env: opts.env ?? {},
  };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

const args = (url: string, ...extra: string[]) => ["-p", "do the task", "--base-url", url, "--model", "m", ...extra];

// ---------- end to end ----------

test("a plain answer goes to stdout and nothing else does", async () => {
  await withProject({}, async () => {
    await withModel(() => ({ text: "The answer is 42." }), async (url) => {
      const c = capture();
      const code = await runHeadless(args(url), c.io);
      assert.equal(code, EXIT.OK);
      assert.equal(c.stdout(), "The answer is 42.\n");
      assert.equal(c.stderr(), "");
    });
  });
});

test("json output is one object with the result, usage and tool statistics", async () => {
  await withProject({ "a.txt": "hello" }, async () => {
    const script = (n: number): Reply => (n === 1 ? { tools: [{ name: "read_file", args: { path: "a.txt" } }] } : { text: "It says hello." });
    await withModel(script, async (url) => {
      const c = capture();
      const code = await runHeadless(args(url, "--output-format", "json"), c.io);
      assert.equal(code, EXIT.OK);
      const r = JSON.parse(c.stdout()) as Record<string, any>;
      assert.equal(r.ok, true);
      assert.equal(r.result, "It says hello.");
      assert.equal(r.stop_reason, "answered");
      assert.equal(r.model, "m");
      assert.equal(r.model_calls, 2);
      assert.deepEqual(r.tool_calls, { total: 1, by_name: { read_file: 1 }, outcomes: { ok: 1 } });
      assert.deepEqual(r.usage, { prompt_tokens: 200, completion_tokens: 20 });
      assert.deepEqual(r.files_changed, []);
      assert.equal(c.stdout().trim().split("\n").length, 1, "exactly one line of JSON");
    });
  });
});

test("read-only by default: the model is not offered write or command tools", async () => {
  await withProject({}, async () => {
    await withModel(() => ({ text: "ok" }), async (url, seen) => {
      await runHeadless(args(url), capture().io);
      const names = seen[0]!.toolNames;
      assert.ok(names.includes("read_file"));
      for (const hidden of ["write_file", "edit_file", "run_command"]) assert.ok(!names.includes(hidden), `${hidden} must not be offered`);
    });
  });
});

test("--allow-write offers the write tools but still not run_command", async () => {
  await withProject({}, async () => {
    await withModel(() => ({ text: "ok" }), async (url, seen) => {
      await runHeadless(args(url, "--allow-write"), capture().io);
      const names = seen[0]!.toolNames;
      assert.ok(names.includes("write_file") && names.includes("edit_file"));
      assert.ok(!names.includes("run_command"));
    });
  });
});

test("--allow-write: the file is written and reported in files_changed", async () => {
  await withProject({}, async (root) => {
    const script = (n: number): Reply =>
      n === 1 ? { tools: [{ name: "write_file", args: { path: "out/new.txt", content: "hi there" } }] } : { text: "Created it." };
    await withModel(script, async (url) => {
      const c = capture();
      const code = await runHeadless(args(url, "--allow-write", "--output-format", "json"), c.io);
      assert.equal(code, EXIT.OK);
      assert.equal(readFileSync(path.join(root, "out/new.txt"), "utf-8"), "hi there");
      assert.deepEqual((JSON.parse(c.stdout()) as { files_changed: string[] }).files_changed, ["out/new.txt"]);
    });
  });
});

test("a write that is approved but then fails is not reported as changed", async () => {
  await withProject({ "a.txt": "plain file" }, async () => {
    // "a.txt" is a file, so a.txt/b.txt can't be created. The write is approved first, then fails.
    const script = (n: number): Reply =>
      n === 1 ? { tools: [{ name: "write_file", args: { path: "a.txt/b.txt", content: "x" } }] } : { text: "Tried." };
    await withModel(script, async (url, seen) => {
      const c = capture();
      await runHeadless(args(url, "--allow-write", "--output-format", "json"), c.io);
      const toolResult = seen[1]!.messages.find((m) => m.role === "tool")!.content!;
      assert.match(toolResult, /^Error/, "precondition: the write must actually fail after approval");
      assert.deepEqual((JSON.parse(c.stdout()) as { files_changed: string[] }).files_changed, []);
    });
  });
});

test("a refused write (no overwrite flag) is not reported as changed either", async () => {
  await withProject({ "exists.txt": "old" }, async (root) => {
    const script = (n: number): Reply =>
      n === 1 ? { tools: [{ name: "write_file", args: { path: "exists.txt", content: "new" } }] } : { text: "Tried." };
    await withModel(script, async (url) => {
      const c = capture();
      await runHeadless(args(url, "--allow-write", "--output-format", "json"), c.io);
      assert.equal(readFileSync(path.join(root, "exists.txt"), "utf-8"), "old");
      assert.deepEqual((JSON.parse(c.stdout()) as { files_changed: string[] }).files_changed, []);
    });
  });
});

test("--allow-command: allowed programs run, everything else is refused with an explanation", async () => {
  await withProject({}, async () => {
    const tracker = newFileTracker();
    const tools = buildHeadlessTools({ allowWrite: false, allowCommands: ["node"] }, tracker);
    const run = tools.find((t) => t.name === "run_command")!;

    const ok = await run.execute({ command: "node --version" });
    assert.match(ok, /Exit code: 0/);
    assert.match(ok, /v\d+/);

    const notListed = await run.execute({ command: "rm -rf ." });
    assert.match(notListed, /declined/i);
    assert.match(notListed, /Allowed commands: node/);

    const chained = await run.execute({ command: "node --version && echo hi" });
    assert.match(chained, /declined/i);
    assert.match(chained, /shell operators/);
  });
});

test("API keys reach the model server but not the commands the agent runs", async () => {
  await withProject({ "print-env.mjs": 'console.log("KEY=" + process.env.MITHRIL_API_KEY + " OAI=" + process.env.OPENAI_API_KEY);' }, async () => {
    process.env.MITHRIL_API_KEY = "sk-secret-1";
    process.env.OPENAI_API_KEY = "sk-secret-2";
    try {
      const script = (n: number): Reply => (n === 1 ? { tools: [{ name: "run_command", args: { command: "node print-env.mjs" } }] } : { text: "done" });
      await withModel(script, async (url, seen) => {
        const c = capture({ env: { MITHRIL_API_KEY: "sk-secret-1" } });
        const code = await runHeadless(args(url, "--allow-command", "node"), c.io);
        assert.equal(code, EXIT.OK);
        for (const request of seen) assert.equal(request.headers.authorization, "Bearer sk-secret-1");
        const toolOutput = seen[1]!.messages.find((m) => m.role === "tool")!.content!;
        assert.match(toolOutput, /KEY=undefined OAI=undefined/);
        assert.ok(!c.stdout().includes("sk-secret") && !c.stderr().includes("sk-secret"));
      });
      // ...and the process environment is put back afterwards.
      assert.equal(process.env.MITHRIL_API_KEY, "sk-secret-1");
      assert.equal(process.env.OPENAI_API_KEY, "sk-secret-2");
    } finally {
      delete process.env.MITHRIL_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });
});

test("the prompt can come from stdin", async () => {
  await withProject({}, async () => {
    await withModel(() => ({ text: "ok" }), async (url, seen) => {
      const c = capture({ stdin: "  summarise the repo\n" });
      const code = await runHeadless(["-p", "--base-url", url, "--model", "m"], c.io);
      assert.equal(code, EXIT.OK);
      assert.equal(seen[0]!.messages.find((m) => m.role === "user")!.content, "summarise the repo");
    });
  });
});

test("no prompt and an interactive terminal is a usage error, not a hang", async () => {
  const c = capture({ tty: true });
  assert.equal(await runHeadless(["-p", "--base-url", "http://127.0.0.1:1", "--model", "m"], c.io), EXIT.USAGE);
  assert.match(c.stderr(), /No prompt given/);
  assert.equal(c.stdout(), "");
});

test("without --base-url it refuses instead of opening the model picker", async () => {
  const c = capture();
  const code = await runHeadless(["-p", "hi"], c.io);
  assert.equal(code, EXIT.USAGE);
  assert.match(c.stderr(), /--base-url/);
  assert.equal(c.stdout(), "");
});

test("usage errors in json mode still produce a parseable object on stdout", async () => {
  const c = capture();
  const code = await runHeadless(["-p", "hi", "--output-format", "json"], c.io);
  assert.equal(code, EXIT.USAGE);
  const r = JSON.parse(c.stdout()) as { ok: boolean; error: string };
  assert.equal(r.ok, false);
  assert.match(r.error, /--base-url/);
});

test("--api-key is refused, like in the chat app", async () => {
  const c = capture();
  assert.equal(await runHeadless(["-p", "hi", "--base-url", "http://x", "--model", "m", "--api-key", "k"], c.io), EXIT.USAGE);
  assert.match(c.stderr(), /MITHRIL_API_KEY/);
});

test("a server error exits 1 and leaves stdout empty", async () => {
  await withProject({}, async () => {
    await withModel(() => ({ status: 500 }), async (url) => {
      const c = capture();
      const code = await runHeadless(args(url), c.io);
      assert.equal(code, EXIT.FAILED);
      assert.equal(c.stdout(), "");
      assert.match(c.stderr(), /Error talking to the model server/);
    });
  });
});

test("a server error in json mode is ok:false with the error and stop_reason", async () => {
  await withProject({}, async () => {
    await withModel(() => ({ status: 500 }), async (url) => {
      const c = capture();
      const code = await runHeadless(args(url, "--output-format", "json"), c.io);
      assert.equal(code, EXIT.FAILED);
      const r = JSON.parse(c.stdout()) as Record<string, any>;
      assert.equal(r.ok, false);
      assert.equal(r.stop_reason, "server_error");
      assert.match(r.error, /Error talking to the model server/);
      assert.equal(r.result, undefined);
    });
  });
});

test("running out of steps exits 3", async () => {
  await withProject({ "a.txt": "x" }, async () => {
    await withModel(() => ({ tools: [{ name: "read_file", args: { path: "a.txt" } }] }), async (url) => {
      const c = capture();
      const code = await runHeadless(args(url, "--max-steps", "2", "--output-format", "json"), c.io);
      assert.equal(code, EXIT.MAX_STEPS);
      const r = JSON.parse(c.stdout()) as Record<string, any>;
      assert.equal(r.ok, false);
      assert.equal(r.stop_reason, "max_steps");
      assert.equal(r.model_calls, 2);
    });
  });
});

test("--timeout stops a slow model and exits 124", async () => {
  await withProject({}, async () => {
    await withModel(() => ({ text: "too late", delayMs: 3000 }), async (url) => {
      const c = capture();
      const started = Date.now();
      const code = await runHeadless(args(url, "--timeout", "0.3"), c.io);
      assert.equal(code, EXIT.TIMEOUT);
      assert.ok(Date.now() - started < 2500, "should not wait for the slow reply");
      assert.match(c.stderr(), /timed out after 0.3s/);
      assert.equal(c.stdout(), "");
    });
  });
});

test("--verbose logs tool calls to stderr and never to stdout", async () => {
  await withProject({ "a.txt": "x" }, async () => {
    const script = (n: number): Reply => (n === 1 ? { tools: [{ name: "read_file", args: { path: "a.txt" } }] } : { text: "done" });
    await withModel(script, async (url) => {
      const c = capture();
      await runHeadless(args(url, "--verbose"), c.io);
      assert.match(c.stderr(), /calling read_file/);
      assert.equal(c.stdout(), "done\n");
    });
  });
});

test("--help prints usage on stdout and exits 0 without needing a server", async () => {
  const c = capture();
  const code = await runHeadless(["-p", "--help"], c.io);
  assert.equal(code, EXIT.OK);
  assert.match(c.stdout(), /Usage: mithril -p/);
  assert.match(c.stdout(), /Exit codes/);
});

// ---------- the real CLI ----------

// Spawned asynchronously: a synchronous spawn would block this process's event
// loop, and the fake model server lives in it.
function runCli(cliArgs: string[], stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("MITHRIL_") || key === "OPENAI_API_KEY") delete env[key];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...cliArgs], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

test("the real CLI: stdout is exactly the answer (no banner, no intro) and the exit code is 0", async () => {
  await withProject({}, async () => {
    await withModel(() => ({ text: "Plain answer." }), async (url) => {
      const r = await runCli(["-p", "hi", "--base-url", url, "--model", "m"]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "Plain answer.\n");
      assert.equal(r.stderr, "");
    });
  });
});

test("the real CLI: a long answer is not truncated when piped", async () => {
  const big = "x".repeat(300_000);
  await withProject({}, async () => {
    await withModel(() => ({ text: big }), async (url) => {
      const r = await runCli(["-p", "hi", "--base-url", url, "--model", "m"]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.length, big.length + 1);
    });
  });
});

test("the real CLI: usage errors exit 2 with nothing on stdout", async () => {
  const r = await runCli(["-p", "hi"]);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /--base-url/);
});

test("the real CLI: prompt from stdin, json output, failure exit code", async () => {
  await withProject({}, async () => {
    await withModel(() => ({ status: 500 }), async (url) => {
      const r = await runCli(["-p", "--base-url", url, "--model", "m", "--output-format", "json"], "do something\n");
      assert.equal(r.code, 1);
      const parsed = JSON.parse(r.stdout) as { ok: boolean; stop_reason: string };
      assert.deepEqual([parsed.ok, parsed.stop_reason], [false, "server_error"]);
    });
  });
});
