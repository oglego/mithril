export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// The shape of one SSE chunk from llama-server's streaming response.
// This is the type safety upgrade we flagged as a stretch goal last time.
export interface StreamChunk {
  choices: {
    delta: {
      content?: string;
    };
  }[];
}