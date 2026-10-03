import type { ChatMessage, StreamChunk, ApiToolDefinition } from "../types.js";

// A config object instead of hardcoded strings — swapping models or
// server URLs now happens in one place.
export interface LlamaClientConfig {
  baseUrl: string;
  model: string;
  queryPrefix?: string;
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

// Calls an embedding-mode server's /v1/embeddings endpoint for a batch of
// texts. If the server supports array input (OpenAI-compatible batch embedding),
// all vectors are returned in a single request. If the server rejects array input
// (such as older llamafile builds), it gracefully falls back to bounded concurrent
// single-text embedding requests.
export async function embedBatch(
  texts: string[],
  config: LlamaClientConfig,
  concurrency = 4
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await embedOnce(texts[0]!, config)];

  try {
    const response = await fetch(`${config.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, input: texts }),
    });

    if (response.ok) {
      interface BatchEmbeddingResponse {
        data?: {
          index?: number;
          embedding?: number[];
        }[];
      }

      const data: BatchEmbeddingResponse = await response.json();
      if (data?.data?.length === texts.length) {
        // Sort by returned index if present, ensuring original order
        const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (sorted.every((item) => Array.isArray(item.embedding))) {
          return sorted.map((item) => item.embedding!);
        }
      }
    }
  } catch {
    // Server threw or network issue during batch request; proceed to fallback
  }

  // Graceful fallback: run concurrent embedOnce requests in chunks of `concurrency`
  const results: number[][] = new Array(texts.length);
  for (let i = 0; i < texts.length; i += concurrency) {
    const slice = texts.slice(i, i + concurrency);
    const chunkEmbeddings = await Promise.all(
      slice.map((text) => embedOnce(text, config))
    );
    for (let j = 0; j < chunkEmbeddings.length; j++) {
      results[i + j] = chunkEmbeddings[j]!;
    }
  }

  return results;
}