import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { resolveBackend, normalizeBaseUrl, parseFlag, parsePortFlag, probeBackend, ConfigError } from "./config.js";

test("defaults to local mode with no flags", () => {
  assert.deepEqual(resolveBackend([], {}), { kind: "local" });
});

test("local mode ignores unrelated flags", () => {
  assert.deepEqual(resolveBackend(["--docs", "./notes"], {}), { kind: "local" });
});

test("remote mode requires --model", () => {
  assert.throws(() => resolveBackend(["--base-url", "http://localhost:11434"], {}), ConfigError);
});

test("--model without --base-url is rejected rather than silently ignored", () => {
  assert.throws(() => resolveBackend(["--model", "qwen3"], {}), ConfigError);
});

test("remote mode resolves base url and model", () => {
  const b = resolveBackend(["--base-url", "http://localhost:11434", "--model", "qwen3:8b"], {});
  assert.deepEqual(b, { kind: "remote", baseUrl: "http://localhost:11434", model: "qwen3:8b", apiKey: undefined });
});

test("api key comes from MITHRIL_API_KEY, then OPENAI_API_KEY", () => {
  const args = ["--base-url", "https://api.example.com", "--model", "m"];
  assert.equal((resolveBackend(args, { OPENAI_API_KEY: "o" }) as any).apiKey, "o");
  assert.equal((resolveBackend(args, { OPENAI_API_KEY: "o", MITHRIL_API_KEY: "m" }) as any).apiKey, "m");
});

test("--api-key flag is refused to keep secrets out of shell history", () => {
  assert.throws(
    () => resolveBackend(["--base-url", "http://x", "--model", "m", "--api-key", "sk-secret"], {}),
    /MITHRIL_API_KEY/
  );
});

test("env vars can supply base url and model", () => {
  const b = resolveBackend([], { MITHRIL_BASE_URL: "http://localhost:1234", MITHRIL_MODEL: "m" });
  assert.equal(b.kind, "remote");
});

test("normalizeBaseUrl strips trailing slash and /v1", () => {
  assert.equal(normalizeBaseUrl("http://localhost:11434/"), "http://localhost:11434");
  assert.equal(normalizeBaseUrl("https://api.openai.com/v1"), "https://api.openai.com");
  assert.equal(normalizeBaseUrl("https://api.openai.com/v1/"), "https://api.openai.com");
  assert.equal(normalizeBaseUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api");
});

test("normalizeBaseUrl rejects garbage and non-http schemes", () => {
  assert.throws(() => normalizeBaseUrl("not a url"), ConfigError);
  assert.throws(() => normalizeBaseUrl("file:///etc/passwd"), ConfigError);
});

test("parseFlag does not swallow a following flag as its value", () => {
  assert.equal(parseFlag(["--model", "--docs", "x"], "--model"), undefined);
  assert.equal(parseFlag(["--model", "abc"], "--model"), "abc");
});

test("probeBackend returns null for a reachable server and warns on 401", async () => {
  const server = createServer((req, res) => {
    res.statusCode = req.headers.authorization === "Bearer good" ? 200 : 401;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal(await probeBackend(base, "good"), null);
    assert.match((await probeBackend(base, "bad")) ?? "", /rejected the credentials/);
  } finally {
    server.close();
  }
});

test("probeBackend warns instead of throwing when nothing is listening", async () => {
  const warning = await probeBackend("http://127.0.0.1:1", undefined, 1000);
  assert.match(warning ?? "", /Could not reach/);
});

test("--llamafile selects a llamafile to start, with its path made absolute", () => {
  assert.deepEqual(resolveBackend(["--llamafile", "models/m.llamafile"], {}), {
    kind: "llamafile",
    path: path.resolve("models/m.llamafile"),
  });
});

test("--llamafile needs a path", () => {
  assert.throws(() => resolveBackend(["--llamafile"], {}), /needs the path/);
  assert.throws(() => resolveBackend(["--llamafile", "--context", "4096"], {}), /needs the path/);
});

test("--llamafile can't be combined with --base-url or --model, which would be silently ignored", () => {
  assert.throws(() => resolveBackend(["--llamafile", "m.llamafile", "--base-url", "http://x"], {}), /can't be combined/);
  assert.throws(() => resolveBackend(["--llamafile", "m.llamafile", "--model", "m"], {}), /can't be combined/);
});

test("an exported MITHRIL_BASE_URL does not stop --llamafile from being used for one command", () => {
  const b = resolveBackend(["--llamafile", "m.llamafile"], { MITHRIL_BASE_URL: "http://x", MITHRIL_MODEL: "m" });
  assert.equal(b.kind, "llamafile");
});

test("--port defaults to 8080 and is validated", () => {
  assert.equal(parsePortFlag([]), 8080);
  assert.equal(parsePortFlag(["--port", "9001"]), 9001);
  for (const bad of ["0", "70000", "80.5", "abc"]) {
    assert.throws(() => parsePortFlag(["--port", bad]), /--port must be/, bad);
  }
  assert.throws(() => parsePortFlag(["--port"]), /--port must be/);
});

test("a bad --port is reported before anything starts, whatever the backend", () => {
  assert.throws(() => resolveBackend(["--port", "0"], {}), /--port must be/);
  assert.throws(() => resolveBackend(["--llamafile", "m.llamafile", "--port", "x"], {}), /--port must be/);
});

test("--port with a remote server is an error: it cannot change where that server listens", () => {
  assert.throws(
    () => resolveBackend(["--base-url", "http://localhost:11434", "--model", "m", "--port", "9000"], {}),
    /--port only applies when Mithril starts the model itself/
  );
});

test("--port alone (the picker will start the model) is fine", () => {
  assert.deepEqual(resolveBackend(["--port", "9000"], {}), { kind: "local" });
});
