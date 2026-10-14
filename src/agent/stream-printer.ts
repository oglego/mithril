// Decides what streamed answer text is safe to show.
//
// Some small models write a tool call as plain text ("<tool_call>{...}") and
// rely on the server to convert it into a structured call. Printing those
// tokens as they arrive would flash raw JSON at the user. So the start of
// each model response is held back briefly: if it looks like a tool call it
// is suppressed, otherwise it is released and everything after it streams
// straight through.

// How many characters to hold back before deciding. Short replies are
// decided when the response ends.
const HOLD_CHARS = 24;

const TOOL_CALL_START = [
  /^<tool_call/i,
  /^<function/i,
  /^<\|/,
  /^\[TOOL_CALLS?\]/i,
  /^\{\s*"(name|tool|function|tool_calls?)"/i,
];

export function looksLikeToolCall(prefix: string): boolean {
  const text = prefix.trimStart();
  return TOOL_CALL_START.some((pattern) => pattern.test(text));
}

export interface StreamedCall {
  // Everything the model sent as answer text, shown or not.
  text: string;
  // True if the text was shown on screen (not suppressed as a tool call).
  shown: boolean;
}

export interface StreamPrinter {
  push(token: string): void;
  // Ends the current model response: flushes anything still held back,
  // reports what happened, and resets for the next response.
  finish(): StreamedCall;
}

export function createStreamPrinter(write: (text: string) => void): StreamPrinter {
  let state: "holding" | "printing" | "suppressed" = "holding";
  let held = "";
  let raw = "";
  let wrote = false;

  const emit = (text: string): void => {
    if (text.length === 0) return;
    wrote = true;
    write(text);
  };

  // Decide once enough text has arrived (or the response has ended).
  const decide = (): void => {
    if (looksLikeToolCall(held)) {
      state = "suppressed";
      held = "";
    } else {
      state = "printing";
      emit(held);
      held = "";
    }
  };

  return {
    push(token) {
      raw += token;
      if (state === "printing") {
        emit(token);
      } else if (state === "holding") {
        held += token;
        if (held.trimStart().length >= HOLD_CHARS || held.includes("\n")) {
          // A newline after real text is as good as a length cutoff, but a
          // leading blank line alone isn't enough to decide.
          if (held.trim().length > 0) decide();
        }
      }
      // "suppressed": drop the token.
    },

    finish() {
      if (state === "holding" && held.length > 0) decide();
      const result = { text: raw, shown: wrote };
      state = "holding";
      held = "";
      raw = "";
      wrote = false;
      return result;
    },
  };
}
