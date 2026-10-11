import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  parseContextFlag,
  fetchServerContextSize,
  resolveContextWindow,
  describeWindow,
  DEFAULT_LOCAL_WINDOW,
  DEFAULT_REMOTE_WINDOW,
  MAX_AUTO_WINDOW,
} from "./context-window.js";
import { ConfigError } from "./config.js";

test("parseContextFlag reads the flag, tolerating separators", () => {
  assert.equal(parseContextFlag(["--context", "8192"], {}), 8192);
  assert.equal(parseContextFlag(["--context", "32_768"], {}), 32768);
  assert.equal(parseContextFlag(["--context", "32,768"], {}), 32768);
});

test("parseContextFlag falls back to MITHRIL_CONTEXT, and the flag wins over it", () => {
  assert.equal(parseContextFlag([], { MITHRIL_CONTEXT: "4096" }), 4096);
  assert.equal(parseContextFlag(["--context", "8192"], { MITHRIL_CONTEXT: "4096" }), 8192);
  assert.equal(parseContextFlag([], {}), undefined);
});

test("parseContextFlag rejects bad values with a clear error", () => {
  assert.throws(() => parseContextFlag(["--context", "abc"], {}), ConfigError);
  assert.throws(() => parseContextFlag(["--context", "100"], {}), /at least 1024/);
  assert.throws(() => parseContextFlag(["--context", "8192.5"], {}), ConfigError);
  assert.throws(() => parseContextFlag(["--context"], {}), /requires a number/);
  assert.throws(() => parseContextFlag(["--context", "--docs", "x"], {}), /requires a number/);
});

test("resolveContextWindow precedence: flag, then server, then default", () => {
  assert.deepEqual(resolveContextWindow({ flag: 5000, detected: 9000, kind: "local" }), { window: 5000, source: "flag" });
  assert.deepEqual(resolveContextWindow({ detected: 9000, kind: "local" }), { window: 9000, source: "server" });
  assert.deepEqual(resolveContextWindow({ kind: "local" }), { window: DEFAULT_LOCAL_WINDOW, source: "default" });
  assert.deepEqual(resolveContextWindow({ kind: "remote" }), { window: DEFAULT_REMOTE_WINDOW, source: "default" });
});

test("resolveContextWindow caps huge detected windows but not an explicit flag", () => {
  assert.equal(resolveContextWindow({ detected: 131_072, kind: "local" }).window, MAX_AUTO_WINDOW);
  assert.equal(resolveContextWindow({ flag: 131_072, kind: "local" }).window, 131_072);
});

test("resolveContextWindow ignores a nonsensical detected value", () => {
  assert.equal(resolveContextWindow({ detected: 10, kind: "local" }).source, "default");
  assert.equal(resolveContextWindow({ detected: null, kind: "remote" }).source, "default");
});

test("describeWindow says where the number came from", () => {
  assert.match(describeWindow({ window: 8192, source: "server" }), /8,192 tokens \(reported by the server\)/);
  assert.match(describeWindow({ window: 4096, source: "flag" }), /set by --context/);
});

async function withServer(body: unknown, status: number, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((_req, res) => {
    res.statusCode = status;
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("fetchServerContextSize understands the known /props layouts", async () => {
  await withServer({ default_generation_settings: { n_ctx: 4096 } }, 200, async (b) => assert.equal(await fetchServerContextSize(b), 4096));
  await withServer({ n_ctx: 8192 }, 200, async (b) => assert.equal(await fetchServerContextSize(b), 8192));
  await withServer({ default_generation_settings: { params: { n_ctx: 2048 } } }, 200, async (b) => assert.equal(await fetchServerContextSize(b), 2048));
});

test("fetchServerContextSize returns null for missing, junk, or unreachable servers", async () => {
  await withServer({}, 200, async (b) => assert.equal(await fetchServerContextSize(b), null));
  await withServer({ n_ctx: "big" }, 200, async (b) => assert.equal(await fetchServerContextSize(b), null));
  await withServer({ n_ctx: -5 }, 200, async (b) => assert.equal(await fetchServerContextSize(b), null));
  await withServer("not json", 200, async (b) => assert.equal(await fetchServerContextSize(b), null));
  await withServer({}, 404, async (b) => assert.equal(await fetchServerContextSize(b), null));
  assert.equal(await fetchServerContextSize("http://127.0.0.1:1", undefined, 1000), null);
});
