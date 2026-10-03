import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, trimHistory } from "./context.js";
import type { ChatMessage } from "../types.js";

// --- estimateTokens ---

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
