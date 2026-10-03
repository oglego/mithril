import type { ChatMessage } from "../types.js";

// A rough but fast token estimate: ~4 characters per token is a widely-used
// heuristic that's close enough for budget enforcement without pulling in a
// real tokenizer (which would be model-specific anyway). Erring slightly on
// the high side is fine — it just means we trim a little earlier than strictly
// necessary, which is safer than trimming too late.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Default token budget — 6 000 tokens is a safe middle ground for the models
// in Mithril's catalog, which range from ~2K to ~32K context windows. The
// smallest models benefit from headroom for the reply, and the larger models
// won't notice the cap. Can be overridden by callers if needed.
export const DEFAULT_MAX_TOKENS = 6000;

// Returns a copy of the history trimmed to fit within `maxTokens`.
//
// Strategy:
//   1. The system prompt (index 0) is always preserved — it defines the
//      assistant's persona and available tools.
//   2. Messages are removed from the *oldest* end (right after the system
//      prompt) until the total is under budget.
//   3. The most recent messages are kept, since they're the most relevant
//      to the current turn.
//
// Returns the number of messages that were removed as a second value, so
// the caller can decide whether to log a warning.
export function trimHistory(
  history: ChatMessage[],
  maxTokens: number = DEFAULT_MAX_TOKENS,
): { trimmed: ChatMessage[]; removedCount: number } {
  if (history.length === 0) {
    return { trimmed: [], removedCount: 0 };
  }

  // Calculate total tokens for the full history.
  const tokenCounts = history.map((m) => estimateTokens(m.content));
  let totalTokens = tokenCounts.reduce((sum, t) => sum + t, 0);

  if (totalTokens <= maxTokens) {
    return { trimmed: history, removedCount: 0 };
  }

  // The system prompt is at index 0; removable messages start at index 1.
  const systemMessage = history[0]!;
  const removableTokens = tokenCounts.slice(1);
  let currentTokens = totalTokens;
  let removeFromStart = 0;

  while (removeFromStart < removableTokens.length && currentTokens > maxTokens) {
    currentTokens -= removableTokens[removeFromStart]!;
    removeFromStart++;
  }

  const kept = history.slice(1).slice(removeFromStart);
  return {
    trimmed: [systemMessage, ...kept],
    removedCount: removeFromStart,
  };
}
