// One incremental tool-call fragment inside a streamed delta. Per the OpenAI
// format, only the first fragment of a call carries `id` and `name`; `index`
// says which call a fragment belongs to (parallel calls interleave by index).
// Some servers omit `index`, and a few send `arguments` as an object.
export interface StreamToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

// The shape of one SSE chunk from llama-server's streaming response.
export interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      // "Thinking" models put their reasoning here instead of in `content`.
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: StreamToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
  // Final chunk when `stream_options.include_usage` is honored (choices is []).
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
  // Some servers report a failure as a data event instead of an HTTP status.
  error?: string | { message?: string } | null;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded string, e.g. '{"path":"package.json"}'
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];  // set on an assistant message that wants to call tools
  tool_call_id?: string;    // set on a tool message, links back to a ToolCall.id
  name?: string;            // the tool name, on tool role messages
}

export interface Tool {
  name: string;
  description: string;
  parameters: object; // JSON schema describing the tool's arguments
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface ApiToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: object };
}