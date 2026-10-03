import type { ChatMessage, StreamChunk, ApiToolDefinition } from "../types.js";

// A config object instead of hardcoded strings — swapping models or
// server URLs now happens in one place.
export interface LlamaClientConfig {
  baseUrl: string;
  model: string;
}

export async function* chatStream(
  messages: ChatMessage[],
  config: LlamaClientConfig
): AsyncGenerator<string> {
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      messages: messages,
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Server error: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;

      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return;

      const chunk: StreamChunk = JSON.parse(payload);
      const token = chunk.choices[0]?.delta?.content;
      if (token) yield token;
    }
  }

  // Process any remaining data left in the buffer after the stream ends.
  // If the server's last SSE line isn't newline-terminated, it would
  // otherwise be silently dropped.
  if (buffer.startsWith("data: ")) {
    const payload = buffer.slice(6).trim();
    if (payload !== "[DONE]") {
      const chunk: StreamChunk = JSON.parse(payload);
      const token = chunk.choices[0]?.delta?.content;
      if (token) yield token;
    }
  }
}

export async function chatOnce(
  messages: ChatMessage[],
  config: LlamaClientConfig,
  toolDefs?: ApiToolDefinition[]
): Promise<ChatMessage> {
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      messages,
      ...(toolDefs ? { tools: toolDefs, tool_choice: "auto" } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`llama-server request failed (${response.status}): ${errorText}`);
  }

  interface ChatCompletionResponse {
    choices?: {
      message?: {
        content?: string;
        tool_calls?: ChatMessage["tool_calls"];
      };
    }[];
  }

  const data: ChatCompletionResponse = await response.json();

  if (!data?.choices?.length || !data.choices[0]?.message) {
    throw new Error("llama-server returned an unexpected response shape (no choices/message).");
  }

  const message = data.choices[0].message;

  return {
    role: "assistant",
    content: message.content ?? "",
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  };
}

// Calls an embedding-mode llamafile server's /v1/embeddings endpoint and
// returns the embedding vector for a single piece of text.
export async function embedOnce(text: string, config: LlamaClientConfig): Promise<number[]> {
  const response = await fetch(`${config.baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, input: text }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`embedding request failed (${response.status}): ${errorText}`);
  }

  interface EmbeddingResponse {
    data?: {
      embedding?: number[];
    }[];
  }

  const data: EmbeddingResponse = await response.json();

  if (!data?.data?.length || !data.data[0]?.embedding) {
    throw new Error("embedding server returned an unexpected response shape.");
  }

  return data.data[0].embedding;
}