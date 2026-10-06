import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, estimateMessageTokens, trimHistory } from "./context.js";
import type { ChatMessage, ToolCall } from "../types.js";

// --- estimateTokens & estimateMessageTokens ---

test("estimates roughly 1 token per 4 characters", () => {
  // 100 chars → ceil(100/4) = 25 tokens
  const text = "x".repeat(100);
  assert.equal(estimateTokens(text), 25);
});

test("returns 0 for an empty string", () => {
  assert.equal(estimateTokens(""), 0);
});

test("rounds up for strings not evenly divisible by 4", () => {
  // 5 chars → ceil(5/4) = 2 tokens
  assert.equal(estimateTokens("hello"), 2);
});

test("estimateMessageTokens accounts for tool_calls name and arguments", () => {
  const toolCall: ToolCall = {
    id: "call_123",
    type: "function",
    function: {
      name: "write_file",
      arguments: JSON.stringify({ path: "test.ts", content: "x".repeat(400) }),
    },
  };

  const message: ChatMessage = {
    role: "assistant",
    content: "", // content is empty when tool_calls are initiated
    tool_calls: [toolCall],
  };

  const tokens = estimateMessageTokens(message);
  // Arguments + name + id has >400 chars, so tokens should be >100
  assert.ok(tokens >= 100, `Expected tokens to be >= 100, got ${tokens}`);
});

test("estimateMessageTokens accounts for tool role metadata and content", () => {
  const message: ChatMessage = {
    role: "tool",
    tool_call_id: "call_123",
    name: "write_file",
    content: "File written successfully",
  };

  const tokens = estimateMessageTokens(message);
  assert.ok(tokens > 0);
});

// --- trimHistory ---

function msg(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

test("returns history unchanged when under budget", () => {
  const history: ChatMessage[] = [
    msg("system", "You are helpful."),
    msg("user", "Hi"),
    msg("assistant", "Hello!"),
  ];

  const { trimmed, removedCount } = trimHistory(history, 10000);

  assert.deepEqual(trimmed, history);
  assert.equal(removedCount, 0);
});

test("preserves the system prompt and removes oldest messages first", () => {
  const system = msg("system", "Short system prompt.");
  const old = msg("user", "x".repeat(4000)); // ~1000 tokens
  const mid = msg("assistant", "y".repeat(4000)); // ~1000 tokens
  const recent = msg("user", "z".repeat(400)); // ~100 tokens

  const history: ChatMessage[] = [system, old, mid, recent];

  // Budget only allows system + recent (~105 + 100 = ~205 tokens).
  // old and mid should be removed.
  const { trimmed, removedCount } = trimHistory(history, 250);

  assert.equal(trimmed[0]?.role, "system");
  assert.equal(trimmed[0]?.content, system.content);
  assert.equal(removedCount, 2);
  assert.equal(trimmed.length, 2); // system + recent
  assert.equal(trimmed[1]?.content, recent.content);
});

test("returns empty array for empty history", () => {
  const { trimmed, removedCount } = trimHistory([], 1000);
  assert.deepEqual(trimmed, []);
  assert.equal(removedCount, 0);
});

test("keeps system prompt even if it alone exceeds the budget", () => {
  const bigSystem = msg("system", "x".repeat(10000)); // ~2500 tokens
  const user = msg("user", "Hi");

  const { trimmed } = trimHistory([bigSystem, user], 100);

  // System prompt is always preserved; user message gets trimmed.
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0]?.role, "system");
});

test("reports the correct number of removed messages", () => {
  const history: ChatMessage[] = [
    msg("system", "sys"),
    msg("user", "a".repeat(2000)),
    msg("assistant", "b".repeat(2000)),
    msg("user", "c".repeat(2000)),
    msg("assistant", "short"),
  ];

  // Budget: ~200 tokens. system (~1) + last assistant (~2) = ~3 tokens.
  // Should remove the 3 middle messages.
  const { trimmed, removedCount } = trimHistory(history, 200);

  assert.equal(removedCount, 3);
  assert.equal(trimmed[0]?.role, "system");
  assert.equal(trimmed[1]?.content, "short");
});

test("atomically trims tool_calls assistant message together with its tool responses", () => {
  const system = msg("system", "You are Mithril.");
  const oldUser = msg("user", "x".repeat(2000)); // ~500 tokens
  const toolAssistant: ChatMessage = {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_abc",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.txt"}' },
      },
    ],
  };
  const toolResponse: ChatMessage = {
    role: "tool",
    tool_call_id: "call_abc",
    name: "read_file",
    content: "a".repeat(2000), // ~500 tokens
  };
  const toolReply = msg("assistant", "Found a.txt");
  const recentUser = msg("user", "Now do something else");

  const history: ChatMessage[] = [
    system,
    oldUser,
    toolAssistant,
    toolResponse,
    toolReply,
    recentUser,
  ];

  // Budget allowing system + toolReply + recentUser (~50 tokens),
  // requiring removal of oldUser and the tool block.
  const { trimmed, removedCount } = trimHistory(history, 100);

  // Assert toolAssistant and toolResponse were removed together
  const hasToolAssistant = trimmed.some((m) => m.tool_calls && m.tool_calls.length > 0);
  const hasToolResponse = trimmed.some((m) => m.role === "tool");
  assert.equal(hasToolAssistant, false, "Assistant tool call should be removed");
  assert.equal(hasToolResponse, false, "Tool response should be removed with its parent call");
  assert.ok(removedCount >= 3, `Expected at least 3 messages removed, got ${removedCount}`);

  // Remaining history must not start with an orphaned tool response
  assert.notEqual(trimmed[1]?.role, "tool");
});

test("preserves intact tool_calls and tool response when within budget", () => {
  const system = msg("system", "You are Mithril.");
  const toolAssistant: ChatMessage = {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_xyz",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"b.txt"}' },
      },
    ],
  };
  const toolResponse: ChatMessage = {
    role: "tool",
    tool_call_id: "call_xyz",
    name: "read_file",
    content: "file content here",
  };
  const finalReply = msg("assistant", "All done");

  const history: ChatMessage[] = [system, toolAssistant, toolResponse, finalReply];

  const { trimmed, removedCount } = trimHistory(history, 5000);
  assert.equal(removedCount, 0);
  assert.equal(trimmed.length, 4);
  assert.equal(trimmed[1]?.role, "assistant");
  assert.ok(trimmed[1]?.tool_calls);
  assert.equal(trimmed[2]?.role, "tool");
  assert.equal(trimmed[2]?.tool_call_id, "call_xyz");
});
