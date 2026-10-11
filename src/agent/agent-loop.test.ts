import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runAgentTurn } from "./agent-loop.js";
import { ContextManager } from "./context-manager.js";
import { estimateMessageTokens } from "./context.js";
import { toolsToApiFormat } from "./tools.js";
import type { ChatMessage, Tool } from "../types.js";

const bigTool: Tool = {
  name: "read_file",
  description: "Reads a file.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  execute: async () => "y".repeat(9000), // ~2250 tokens per call: far bigger than the budget allows
};

interface Seen {
  messages: ChatMessage[];
}

// Fake OpenAI-compatible server: asks for `toolSteps` tool calls, then answers.
async function withFakeModel(
  toolSteps: number,
  reportedPromptTokens: number | undefined,
  fn: (baseUrl: string, seen: Seen[]) => Promise<void>
): Promise<void> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: ChatMessage[] };
      seen.push({ messages: parsed.messages });
      const n = seen.length;
      res.setHeader("Content-Type", "application/json");
      const usage = reportedPromptTokens === undefined ? {} : { usage: { prompt_tokens: reportedPromptTokens } };
      if (n <= toolSteps) {
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `call_${n}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `f${n}.ts` }) } }] } }],
          ...usage,
        }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "All done." } }], ...usage }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.close();
  }
}

function promptTokens(messages: ChatMessage[]): number {
  const defs = toolsToApiFormat([bigTool]);
  return Math.ceil(JSON.stringify(defs).length / 4) + messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
}

function assertWellFormed(messages: ChatMessage[]): void {
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");
  const calls = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) calls.add(c.id);
    if (m.role === "tool") assert.ok(m.tool_call_id && calls.has(m.tool_call_id), "orphaned tool message in request");
  }
}

const BUDGET = 1500;
const newHistory = (): ChatMessage[] => [
  { role: "system", content: "You are a coding assistant." },
  { role: "user", content: "Read every file and report back." },
];

test("a long tool-using turn never sends a prompt over budget", async () => {
  await withFakeModel(10, undefined, async (baseUrl, seen) => {
    const manager = new ContextManager({ contextWindow: 3000, maxInputTokens: BUDGET });
    const compactions: number[] = [];
    const history = newHistory();

    const reply = await runAgentTurn(history, [bigTool], { baseUrl, model: "m" }, undefined, 20, {
      manager,
      onCompact: (r) => compactions.push(r.tokensAfter),
    });

    assert.equal(reply, "All done.");
    assert.equal(seen.length, 11, "10 tool steps plus the final answer");
    assert.ok(compactions.length > 0, "compaction must have kicked in mid-turn");

    for (const [i, request] of seen.entries()) {
      assert.ok(promptTokens(request.messages) <= BUDGET, `request ${i + 1} was ~${promptTokens(request.messages)} tokens (budget ${BUDGET})`);
      assertWellFormed(request.messages);
      assert.equal(request.messages[1]!.content, "Read every file and report back.", "the task must stay pinned");
    }
  });
});

test("control: without a context manager the same turn blows far past the budget", async () => {
  await withFakeModel(10, undefined, async (baseUrl, seen) => {
    await runAgentTurn(newHistory(), [bigTool], { baseUrl, model: "m" }, undefined, 20);
    const worst = Math.max(...seen.map((s) => promptTokens(s.messages)));
    assert.ok(worst > BUDGET * 5, `expected an oversized prompt, got ~${worst}`);
  });
});

test("a single oversized tool result is capped as it arrives", async () => {
  await withFakeModel(1, undefined, async (baseUrl, seen) => {
    // Budget 1500 tokens -> per-result cap of 2000 chars; the tool returns 9000.
    const manager = new ContextManager({ contextWindow: 3000, maxInputTokens: 1500 });
    assert.equal(manager.maxToolResultChars, 2000);
    const history = newHistory();
    await runAgentTurn(history, [bigTool], { baseUrl, model: "m" }, undefined, 5, { manager });
    const toolMsg = seen[1]!.messages.find((m) => m.role === "tool")!;
    assert.ok(toolMsg.content.length <= 2000, `tool result was ${toolMsg.content.length} chars`);
    assert.ok(/characters omitted/.test(toolMsg.content));
    assert.ok(history.find((m) => m.role === "tool")!.content.length <= 2000);
  });
});

test("server-reported usage calibrates the estimator, and usage never leaks into history", async () => {
  await withFakeModel(2, 50_000, async (baseUrl, seen) => {
    const manager = new ContextManager({ contextWindow: 200_000, maxInputTokens: 150_000 });
    const history = newHistory();
    await runAgentTurn(history, [bigTool], { baseUrl, model: "m" }, undefined, 10, { manager });
    assert.equal(manager.calibrator.factor, 4, "an absurdly high reading clamps at 4x");
    assert.ok(manager.calibrator.samples >= 1);
    for (const m of history) assert.ok(!("usage" in m), "usage must not be stored on messages");
    for (const r of seen) for (const m of r.messages) assert.ok(!("usage" in m));
  });
});

test("stops with a helpful message, without calling the model, when the request can never fit", async () => {
  await withFakeModel(0, undefined, async (baseUrl, seen) => {
    const manager = new ContextManager({ contextWindow: 1000, maxInputTokens: 400 });
    const history: ChatMessage[] = [
      { role: "system", content: "S" },
      { role: "user", content: "w".repeat(10_000) },
    ];
    const reply = await runAgentTurn(history, [bigTool], { baseUrl, model: "m" }, undefined, 5, { manager });
    assert.match(reply, /^\(Stopped: .*--context/);
    assert.equal(seen.length, 0, "no oversized request may be sent");
  });
});

test("behaves exactly as before when no context manager is supplied", async () => {
  await withFakeModel(1, undefined, async (baseUrl, seen) => {
    const history = newHistory();
    const reply = await runAgentTurn(history, [bigTool], { baseUrl, model: "m" });
    assert.equal(reply, "All done.");
    assert.equal(seen[1]!.messages.find((m) => m.role === "tool")!.content.length, 9000, "no capping without a manager");
  });
});

test("when the fixed overhead alone exceeds the budget, the stop message says so and suggests a window", async () => {
  await withFakeModel(0, undefined, async (baseUrl, seen) => {
    // Tiny budget; the user's message is small, so the culprit is system prompt + tools.
    const manager = new ContextManager({ contextWindow: 600, maxInputTokens: 100 });
    const history: ChatMessage[] = [
      { role: "system", content: "S".repeat(2000) },
      { role: "user", content: "hi" },
    ];
    const reply = await runAgentTurn(history, [bigTool], { baseUrl, model: "m" }, undefined, 5, { manager });
    assert.ok(/system prompt and tool definitions alone use ~\d+ tokens/.test(reply), reply);
    assert.ok(/--context \d+ or larger/.test(reply), reply);
    assert.equal(seen.length, 0);
  });
});
