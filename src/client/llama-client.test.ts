import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { buildHeaders, chatOnce, embedOnce } from "./llama-client.js";

test("buildHeaders omits Authorization when no api key is set", () => {
  assert.deepEqual(buildHeaders({ baseUrl: "http://x", model: "m" }), { "Content-Type": "application/json" });
});

test("buildHeaders adds a Bearer token when an api key is set", () => {
  const h = buildHeaders({ baseUrl: "http://x", model: "m", apiKey: "sk-test" });
  assert.equal(h.Authorization, "Bearer sk-test");
});

test("chatOnce and embedOnce send the Authorization header on the wire", async () => {
  const seen: IncomingMessage["headers"][] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/chat/completions") {
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: undefined } }] }));
    } else {
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const config = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: "m", apiKey: "sk-wire" };
  try {
    const reply = await chatOnce([{ role: "user", content: "hi" }], config);
    assert.equal(reply.content, ""); // null content (common on hosted APIs) is normalised
    await embedOnce("hi", config);
    assert.equal(seen.length, 2);
    for (const h of seen) assert.equal(h.authorization, "Bearer sk-wire");
  } finally {
    server.close();
  }
});
