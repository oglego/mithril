import type { ChatMessage } from "../types.js";

// A rough but fast token estimate: ~4 characters per token is a widely-used
// heuristic that's close enough for budget enforcement without pulling in a
// real tokenizer (which would be model-specific anyway). Erring slightly on
// the high side is fine — it just means we trim a little earlier than strictly
// necessary, which is safer than trimming too late.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Estimates tokens for an entire ChatMessage, taking into account not just
// message.content but also tool_calls (names, arguments, IDs) and tool role metadata.
// When an assistant calls a tool with a large payload (or a write_file tool),
// content is often empty while arguments contain thousands of characters.
export function estimateMessageTokens(message: ChatMessage): number {
  let chars = (message.content ?? "").length;
  if (message.tool_calls) {
    for (const call of message.tool_calls) {
      chars += (call.function?.name ?? "").length;
      chars += (call.function?.arguments ?? "").length;
      if (call.id) chars += call.id.length;
    }
  }
  if (message.name) {
    chars += message.name.length;
  }
  if (message.tool_call_id) {
    chars += message.tool_call_id.length;
  }
  return Math.ceil(chars / 4);
}

// Default token budget — 6 000 tokens is a safe middle ground for the models
// in Mithril's catalog, which range from ~2K to ~32K context windows. The
// smallest models benefit from headroom for the reply, and the larger models
// won't notice the cap. Can be overridden by callers if needed.
export const DEFAULT_MAX_TOKENS = 6000;

interface MessageBlock {
  messages: ChatMessage[];
  tokens: number;
}

// Groups messages into atomic blocks so trimming never severs a tool call from
// its response. In OpenAI-compatible APIs, an assistant message with tool_calls
// must be immediately followed by the corresponding tool responses.
function groupHistoryBlocks(messages: ChatMessage[]): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const blockMessages = [msg];
      i++;
      while (i < messages.length && messages[i]!.role === "tool") {
        blockMessages.push(messages[i]!);
        i++;
      }
      const tokens = blockMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
      blocks.push({ messages: blockMessages, tokens });
    } else {
      blocks.push({
        messages: [msg],
        tokens: estimateMessageTokens(msg),
      });
      i++;
    }
  }

  return blocks;
}

// Returns a copy of the history trimmed to fit within `maxTokens`.
//
// Strategy:
//   1. The system prompt (index 0) is always preserved — it defines the
//      assistant's persona and available tools.
//   2. Messages are grouped into atomic blocks: assistant tool_calls and
//      their subsequent tool responses are bound together so they are
//      never severed.
//   3. Blocks are removed from the *oldest* end until the total is under budget.
//   4. The most recent messages are kept, since they're the most relevant.
//
// Returns the number of messages that were removed as a second value.
export function trimHistory(
  history: ChatMessage[],
  maxTokens: number = DEFAULT_MAX_TOKENS,
): { trimmed: ChatMessage[]; removedCount: number } {
  if (history.length === 0) {
    return { trimmed: [], removedCount: 0 };
  }

  const systemMessage = history[0]!;
  const systemTokens = estimateMessageTokens(systemMessage);

  if (history.length === 1) {
    return { trimmed: [systemMessage], removedCount: 0 };
  }

  const blocks = groupHistoryBlocks(history.slice(1));
  let currentTokens = systemTokens + blocks.reduce((sum, b) => sum + b.tokens, 0);

  if (currentTokens <= maxTokens) {
    return { trimmed: history, removedCount: 0 };
  }

  let removeIndex = 0;
  let removedCount = 0;

  while (removeIndex < blocks.length && currentTokens > maxTokens) {
    currentTokens -= blocks[removeIndex]!.tokens;
    removedCount += blocks[removeIndex]!.messages.length;
    removeIndex++;
  }

  const keptBlocks = blocks.slice(removeIndex);
  let keptMessages = keptBlocks.flatMap((b) => b.messages);

  // Safety sanitize: if for any reason the first non-system message is an orphaned
  // tool message, drop it to ensure valid OpenAI conversation format.
  while (keptMessages.length > 0 && keptMessages[0]!.role === "tool") {
    keptMessages.shift();
    removedCount++;
  }

  return {
    trimmed: [systemMessage, ...keptMessages],
    removedCount,
  };
}
