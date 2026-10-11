import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { REMOTE_PRESETS } from "./remote-setup.js";
import { normalizeBaseUrl, fetchModelIds } from "../config.js";

test("every preset URL is already in the normalized form the client expects", () => {
  for (const preset of REMOTE_PRESETS) {
    if (!preset.baseUrl) continue;
    assert.equal(normalizeBaseUrl(preset.baseUrl), preset.baseUrl, preset.id);
  }
});

test("presets have unique ids and exactly one custom entry", () => {
  const ids = REMOTE_PRESETS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(REMOTE_PRESETS.filter((r) => !r.baseUrl).length, 1);
});

async function withServer(
  handler: Parameters<typeof createServer>[1],
  fn: (base: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("fetchModelIds returns sorted, de-duplicated ids and sends the key", () =>
  withServer(
    (req, res) => {
      assert.equal(req.headers.authorization, "Bearer k");
      res.end(JSON.stringify({ data: [{ id: "b" }, { id: "a" }, { id: "a" }, { nope: 1 }, null] }));
    },
    async (base) => {
      assert.deepEqual(await fetchModelIds(base, "k"), { ids: ["a", "b"], warning: null });
    }
  ));

test("fetchModelIds reports bad credentials as a warning with no ids", () =>
  withServer(
    (_req, res) => {
      res.statusCode = 401;
      res.end("{}");
    },
    async (base) => {
      const r = await fetchModelIds(base, "bad");
      assert.deepEqual(r.ids, []);
      assert.match(r.warning ?? "", /rejected the credentials/);
    }
  ));

test("fetchModelIds treats a server without /v1/models as reachable (no warning)", () =>
  withServer(
    (_req, res) => {
      res.statusCode = 404;
      res.end("not found");
    },
    async (base) => {
      assert.deepEqual(await fetchModelIds(base), { ids: [], warning: null });
    }
  ));

test("fetchModelIds survives non-JSON bodies and unreachable servers", async () => {
  await withServer((_req, res) => res.end("<html>hi</html>"), async (base) => {
    assert.deepEqual(await fetchModelIds(base), { ids: [], warning: null });
  });
  const down = await fetchModelIds("http://127.0.0.1:1", undefined, 1000);
  assert.match(down.warning ?? "", /Could not reach/);
});
