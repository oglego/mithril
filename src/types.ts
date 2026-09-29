// The shape of one SSE chunk from llama-server's streaming response.
// This is the type safety upgrade we flagged as a stretch goal last time.
export interface StreamChunk {
  choices: {
    delta: {
      content?: string;
    };
  }[];
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