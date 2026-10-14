import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runAgentTurn, type AgentObserver, type StopReason } from "./agent-loop.js";
import type { ChatMessage, Tool } from "../types.js";

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const text = (content: string) => sse({ choices: [{ delta: { content } }] });
const finish = (reason: string) => sse({ choices: [{ delta: {}, finish_reason: reason }] });
const fragment = (delta: object) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, ...delta }] } }] });

// A fake model that streams step 1 as a tool call (arguments split across
// chunks) and step 2 as a plain-text answer. `breakFirstStream` instead cuts
// the first response off in the middle of the tool call.
async function withStreamingModel(
  opts: { breakFirstStream?: boolean },
  fn: (baseUrl: string, requests: Record<string, unknown>[]) => Promise<void>
): Promise<void> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      const n = requests.length;
      if (requests[n - 1]?.stream !== true) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "non-streamed answer" } }] }));
        return;
      }
      res.setHeader("Content-Type", "text/event-stream");
      if (n === 1) {
        res.write(fragment({ id: "call_1", function: { name: "read_file", arguments: "" } }));
        res.write(fragment({ function: { arguments: '{"path":' } }));
        if (opts.breakFirstStream) {
          res.destroy();
          return;
        }
        res.write(fragment({ function: { arguments: '"a.ts"}' } }));
        res.write(finish("tool_calls"));
        res.write(sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 9 } }));
      } else {
        res.write(text("File "));
        res.write(text("read."));
        res.write(finish("stop"));
        res.write(sse({ choices: [], usage: { prompt_tokens: 140, completion_tokens: 3 } }));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function makeTool(calls: Record<string, unknown>[]): Tool {
  return {
    name: "read_file",
    description: "Reads a file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (args) => {
      calls.push(args);
      return "contents of a.ts";
    },
  };
}

test("a streamed turn runs the tool with fully assembled arguments, then streams the answer", async () => {
  await withStreamingModel({}, async (baseUrl) => {
    const toolCalls: Record<string, unknown>[] = [];
    const tokens: string[] = [];
    const modelCalls: Array<number | undefined> = [];
    const observer: AgentObserver = {
      onToken: (t) => tokens.push(t),
      onModelCall: (info) => modelCalls.push(info.promptTokens),
    };
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "read a.ts" },
    ];

    const reply = await runAgentTurn(history, [makeTool(toolCalls)], { baseUrl, model: "m" }, undefined, undefined, undefined, observer);

    assert.equal(reply, "File read.");
    assert.deepEqual(tokens, ["File ", "read."]); // the tool call produced no answer text
    assert.deepEqual(toolCalls, [{ path: "a.ts" }]);
    assert.deepEqual(modelCalls, [100, 140]); // usage still reaches the observer
    const roles = history.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "tool", "assistant"]);
    assert.equal(history[3]?.tool_call_id, "call_1");
  });
});

test("a stream cut off mid tool call never runs the tool and stops with server_error", async () => {
  await withStreamingModel({ breakFirstStream: true }, async (baseUrl) => {
    const toolCalls: Record<string, unknown>[] = [];
    let stopped: StopReason | undefined;
    const history: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "read a.ts" }];

    const reply = await runAgentTurn(
      history,
      [makeTool(toolCalls)],
      { baseUrl, model: "m" },
      undefined,
      undefined,
      undefined,
      { onToken: () => {}, onStop: (r) => (stopped = r) }
    );

    assert.match(reply, /Error talking to the model server/);
    assert.equal(stopped, "server_error");
    assert.deepEqual(toolCalls, []);
    assert.equal(history.length, 2, "no partial assistant message is added to the history");
  });
});

test("without onToken the loop still makes plain non-streaming requests", async () => {
  await withStreamingModel({}, async (baseUrl, requests) => {
    const history: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }];
    const reply = await runAgentTurn(history, [makeTool([])], { baseUrl, model: "m" });
    assert.equal(reply, "non-streamed answer");
    assert.equal(requests[0]?.stream, undefined);
  });
});
