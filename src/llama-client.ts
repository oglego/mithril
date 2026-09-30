import type { ChatMessage, StreamChunk, ApiToolDefinition } from "./types.js";

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

  const data = await response.json();

  if (!data?.choices?.length || !data.choices[0]?.message) {
    throw new Error("llama-server returned an unexpected response shape (no choices/message).");
  }

  const message = data.choices[0].message;

  return {
    role: "assistant",
    content: message.content ?? "",
    tool_calls: message.tool_calls,
  };
}