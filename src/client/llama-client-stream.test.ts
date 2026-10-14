import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chatStream, chatStreamWithUsage } from "./llama-client.js";
import type { ChatMessage } from "../types.js";

const hi: ChatMessage[] = [{ role: "user", content: "hi" }];

// Wire format helpers: one SSE event per object, as an OpenAI-style server sends them.
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const textChunk = (content: string) => sse({ choices: [{ delta: { content } }] });
const finish = (reason = "stop") => sse({ choices: [{ delta: {}, finish_reason: reason }] });
const DONE = "data: [DONE]\n\n";

interface Captured {
  body: Record<string, unknown>;
}

// Serves `events` as an SSE response (or `raw` with a custom content type)
// and passes the test the base URL plus what the client sent.
async function withStreamServer(
  respond: { events?: string[]; contentType?: string; destroyAfter?: boolean },
  fn: (baseUrl: string, captured: Captured) => Promise<void>
): Promise<void> {
  const captured: Captured = { body: {} };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.body = JSON.parse(body) as Record<string, unknown>;
      res.setHeader("Content-Type", respond.contentType ?? "text/event-stream");
      for (const event of respond.events ?? []) res.write(event);
      if (respond.destroyAfter) {
        res.destroy(); // simulate a dropped connection
      } else {
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, captured);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("streams answer text through onToken and returns the joined message", async () => {
  await withStreamServer({ events: [textChunk("Hel"), textChunk("lo"), finish(), DONE] }, async (baseUrl, captured) => {
    const tokens: string[] = [];
    const { message } = await chatStreamWithUsage(hi, { baseUrl, model: "m" }, undefined, {
      onToken: (t) => tokens.push(t),
    });
    assert.deepEqual(tokens, ["Hel", "lo"]);
    assert.equal(message.content, "Hello");
    assert.equal(message.tool_calls, undefined);
    // The request asks for streaming and for usage in the final chunk.
    assert.equal(captured.body.stream, true);
    assert.deepEqual(captured.body.stream_options, { include_usage: true });
  });
});

test("reports usage from the trailing usage-only chunk", async () => {
  const events = [
    textChunk("ok"),
    finish(),
    sse({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7 } }),
    DONE,
  ];
  await withStreamServer({ events }, async (baseUrl) => {
    const { usage } = await chatStreamWithUsage(hi, { baseUrl, model: "m" });
    assert.equal(usage.promptTokens, 120);
    assert.equal(usage.completionTokens, 7);
  });
});

test("usage is simply absent when the server never sends it", async () => {
  await withStreamServer({ events: [textChunk("ok"), finish(), DONE] }, async (baseUrl) => {
    const { usage } = await chatStreamWithUsage(hi, { baseUrl, model: "m" });
    assert.equal(usage.promptTokens, undefined);
    assert.equal(usage.completionTokens, undefined);
  });
});

test("assembles one tool call whose name and arguments arrive in fragments", async () => {
  const call = (delta: object) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, ...delta }] } }] });
  const events = [
    call({ id: "call_abc", type: "function", function: { name: "read_", arguments: "" } }),
    call({ function: { name: "file" } }),
    call({ function: { arguments: '{"pa' } }),
    call({ function: { arguments: 'th":"a.ts"}' } }),
    finish("tool_calls"),
    DONE,
  ];
  await withStreamServer({ events }, async (baseUrl) => {
    const { message } = await chatStreamWithUsage(hi, { baseUrl, model: "m" });
    assert.equal(message.tool_calls?.length, 1);
    const [c] = message.tool_calls ?? [];
    assert.equal(c?.id, "call_abc");
    assert.equal(c?.function.name, "read_file");
    assert.deepEqual(JSON.parse(c?.function.arguments ?? ""), { path: "a.ts" });
  });
});

test("keeps parallel tool calls apart by index, even when fragments interleave", async () => {
  const frag = (index: number, delta: object) => sse({ choices: [{ delta: { tool_calls: [{ index, ...delta }] } }] });
  const events = [
    frag(0, { id: "c0", function: { name: "read_file", arguments: '{"path":' } }),
    frag(1, { id: "c1", function: { name: "list_dir", arguments: '{"path":' } }),
    frag(1, { function: { arguments: '"src"}' } }),
    frag(0, { function: { arguments: '"a.ts"}' } }),
    finish("tool_calls"),
    DONE,
  ];
  await withStreamServer({ events }, async (baseUrl) => {
    const { message } = await chatStreamWithUsage(hi, { baseUrl, model: "m" });
    const calls = message.tool_calls ?? [];
    assert.deepEqual(
      calls.map((c) => [c.id, c.function.name, JSON.parse(c.function.arguments)]),
      [
        ["c0", "read_file", { path: "a.ts" }],
        ["c1", "list_dir", { path: "src" }],
      ]
    );
  });
});

test("accepts a whole tool call delivered in a single chunk", async () => {
  const events = [
    sse({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"x"}' } }] } },
      ],
    }),
    finish("tool_calls"),
    DONE,
  ];
  await withStreamServer({ events }, async (baseUrl) => {
    const { message } = await chatStreamWithUsage(hi, { baseUrl, model: "m" });
    assert.equal(message.tool_calls?.[0]?.function.name, "read_file");
  });
});

test("copes with servers that omit tool-call index", async () => {
  const frag = (delta: object) => sse({ choices: [{ delta: { tool_calls: [delta] } }] });
  const events = [
    frag({ id: "c1", function: { name: "read_file", arguments: '{"path":' } }),
    frag({ function: { arguments: '"a"}' } }),
    frag({ id: "c2", function: { name: "list_dir", arguments: "{}" } }),
    finish("tool_calls"),
    DONE,
  ];
  await withStreamServer({ events }, async (baseUrl) => {
    const { message } = await chatStreamWithUsage(hi, { baseUrl, model: "m" });
    const calls = message.tool_calls ?? [];
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.function.arguments, '{"path":"a"}');
    assert.equal(calls[1]?.function.name, "list_dir");
  });
});

test("accepts tool arguments sent as an object, and empty arguments as {}", async () => {
  const events = [
    sse({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "c0", function: { name: "read_file", arguments: { path: "a.ts" } } },
              { index: 1, id: "c1", function: { name: "list_dir" } },
            ],
          },
        },
      ],
    }),
    finish("tool_calls"),
    DONE,
  ];
  await withStreamServer({ events }, async (baseUrl) => {
    const { message } = await chatStreamWithUsage(hi, { baseUrl, model: "m" });
    assert.equal(message.tool_calls?.[0]?.function.arguments, '{"path":"a.ts"}');
    assert.equal(message.tool_calls?.[1]?.function.arguments, "{}");
  });
});

test("generates unique ids when the server supplies none", async () => {
  const events = [
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "list_dir", arguments: "{}" } }] } }] }),
    finish("tool_calls"),
    DONE,
  ];
  await withStreamServer({ events }, async (baseUrl) => {
    const a = await chatStreamWithUsage(hi, { baseUrl, model: "m" });
    const b = await chatStreamWithUsage(hi, { baseUrl, model: "m" });
    const idA = a.message.tool_calls?.[0]?.id;
    const idB = b.message.tool_calls?.[0]?.id;
    assert.ok(idA && idB);
    assert.notEqual(idA, idB);
  });
});

test("routes reasoning text to onReasoning and keeps it out of the answer", async () => {
  const events = [
    sse({ choices: [{ delta: { reasoning_content: "let me think" } }] }),
    sse({ choices: [{ delta: { reasoning: "more thought" } }] }),
    textChunk("The answer."),
    finish(),
    DONE,
  ];
  await withStreamServer({ events }, async (baseUrl) => {
    const reasoning: string[] = [];
    const tokens: string[] = [];
    const { message } = await chatStreamWithUsage(hi, { baseUrl, model: "m" }, undefined, {
      onToken: (t) => tokens.push(t),
      onReasoning: (t) => reasoning.push(t),
    });
    assert.deepEqual(reasoning, ["let me think", "more thought"]);
    assert.deepEqual(tokens, ["The answer."]);
    assert.equal(message.content, "The answer.");
  });
});

test("handles CRLF line endings and SSE comment lines", async () => {
  const events = [
    ": keep-alive\r\n\r\n",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\r\n\r\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\r\n\r\n`,
    "data: [DONE]\r\n\r\n",
  ];
  await withStreamServer({ events }, async (baseUrl) => {
    const { message } = await chatStreamWithUsage(hi, { baseUrl, model: "m" });
    assert.equal(message.content, "ok");
  });
});

test("accepts a final event that is not newline-terminated", async () => {
  const events = [textChunk("ok"), finish(), "data: [DONE]"];
  await withStreamServer({ events }, async (baseUrl) => {
    const { message } = await chatStreamWithUsage(hi, { baseUrl, model: "m" });
    assert.equal(message.content, "ok");
  });
});

test("finishes without [DONE] if the server sent a finish_reason", async () => {
  await withStreamServer({ events: [textChunk("ok"), finish()] }, async (baseUrl) => {
    const { message } = await chatStreamWithUsage(hi, { baseUrl, model: "m" });
    assert.equal(message.content, "ok");
  });
});

test("a stream cut off mid tool call throws instead of returning a half-built call", async () => {
  const events = [
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c0", function: { name: "read_file", arguments: '{"pa' } }] } }] }),
  ];
  await withStreamServer({ events, destroyAfter: true }, async (baseUrl) => {
    await assert.rejects(chatStreamWithUsage(hi, { baseUrl, model: "m" }));
  });
});

test("a stream that closes cleanly without finishing also throws", async () => {
  await withStreamServer({ events: [textChunk("partial")] }, async (baseUrl) => {
    await assert.rejects(chatStreamWithUsage(hi, { baseUrl, model: "m" }), /before the model finished/);
  });
});

test("an error event mid-stream is surfaced", async () => {
  const events = [textChunk("partial"), sse({ error: { message: "out of memory" } })];
  await withStreamServer({ events }, async (baseUrl) => {
    await assert.rejects(chatStreamWithUsage(hi, { baseUrl, model: "m" }), /out of memory/);
  });
});

test("a malformed chunk throws a readable error", async () => {
  await withStreamServer({ events: ["data: {not json\n\n"] }, async (baseUrl) => {
    await assert.rejects(chatStreamWithUsage(hi, { baseUrl, model: "m" }), /malformed chunk/);
  });
});

test("falls back to a plain JSON body when the server ignores stream: true", async () => {
  const body = JSON.stringify({
    choices: [{ message: { role: "assistant", content: "whole answer" } }],
    usage: { prompt_tokens: 50, completion_tokens: 3 },
  });
  await withStreamServer({ events: [body], contentType: "application/json" }, async (baseUrl) => {
    const tokens: string[] = [];
    const { message, usage } = await chatStreamWithUsage(hi, { baseUrl, model: "m" }, undefined, {
      onToken: (t) => tokens.push(t),
    });
    assert.equal(message.content, "whole answer");
    assert.deepEqual(tokens, ["whole answer"]);
    assert.equal(usage.promptTokens, 50);
  });
});

test("a non-2xx response throws with the status, like the non-streaming call", async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 401;
    res.end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await assert.rejects(chatStreamWithUsage(hi, { baseUrl, model: "m" }), /401.*MITHRIL_API_KEY/);
  } finally {
    server.close();
  }
});

test("aborting the signal stops a stream in progress", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(textChunk("start"));
      // ...and never finish.
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const controller = new AbortController();
    const seen: string[] = [];
    const pending = chatStreamWithUsage(hi, { baseUrl, model: "m", signal: controller.signal }, undefined, {
      onToken: (t) => {
        seen.push(t);
        controller.abort();
      },
    });
    await assert.rejects(pending);
    assert.deepEqual(seen, ["start"]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("chatStream (plain text) still yields tokens after the SSE refactor", async () => {
  await withStreamServer({ events: [textChunk("a"), textChunk("b"), DONE] }, async (baseUrl) => {
    const out: string[] = [];
    for await (const t of chatStream(hi, { baseUrl, model: "m" })) out.push(t);
    assert.deepEqual(out, ["a", "b"]);
  });
});
