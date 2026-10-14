import type { ChatMessage, StreamChunk, ApiToolDefinition, ToolCall } from "../types.js";

// A config object instead of hardcoded strings — swapping models or
// server URLs now happens in one place.
export interface LlamaClientConfig {
  baseUrl: string;
  model: string;
  queryPrefix?: string;
  // Bearer token for hosted/authenticated OpenAI-compatible backends.
  // Local llamafile servers don't need one, so this stays optional.
  apiKey?: string | undefined;
  // Sampling temperature. Left unset, the server's own default applies.
  temperature?: number | undefined;
  // Aborts an in-flight chat request (used for wall-clock limits in evals).
  signal?: AbortSignal | undefined;
}

// Single place that decides which headers every request carries, so the
// auth header can't be forgotten on one of the four call sites below.
export function buildHeaders(config: LlamaClientConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  };
}


// Yields the payload of each `data:` line of a Server-Sent Events body, with
// line endings (\n or \r\n) and comment lines handled. Stops reading (and
// cancels the body) when the consumer stops iterating.
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const payloadOf = (line: string): string | undefined => {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.startsWith("data:")) return undefined;
    const payload = trimmed.slice(5).trim();
    return payload === "" ? undefined : payload;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const payload = payloadOf(line);
        if (payload !== undefined) yield payload;
      }
    }

    // If the server's last SSE line isn't newline-terminated, it would
    // otherwise be silently dropped.
    buffer += decoder.decode();
    const payload = payloadOf(buffer);
    if (payload !== undefined) yield payload;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function* chatStream(
  messages: ChatMessage[],
  config: LlamaClientConfig
): AsyncGenerator<string> {
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: buildHeaders(config),
    body: JSON.stringify({
      model: config.model,
      messages: messages,
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Server error: ${response.status}`);
  }

  for await (const payload of sseData(response.body)) {
    if (payload === "[DONE]") return;
    const chunk: StreamChunk = JSON.parse(payload);
    const token = chunk.choices?.[0]?.delta?.content;
    if (token) yield token;
  }
}

export interface ChatUsage {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
}

// Callbacks for a streamed model call. They are purely passive and must not
// throw.
export interface StreamCallbacks {
  // Visible answer text, as it arrives.
  onToken?: ((text: string) => void) | undefined;
  // "Thinking" text from reasoning models. It is never part of the answer.
  onReasoning?: ((text: string) => void) | undefined;
}

function chatRequestBody(
  messages: ChatMessage[],
  config: LlamaClientConfig,
  toolDefs: ApiToolDefinition[] | undefined,
  stream: boolean
): string {
  return JSON.stringify({
    model: config.model,
    messages,
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(toolDefs ? { tools: toolDefs, tool_choice: "auto" } : {}),
    // Ask for token usage in the final chunk, so context budgeting stays
    // calibrated while streaming. Servers that ignore it just omit usage.
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  });
}

async function failIfNotOk(response: Response): Promise<void> {
  if (response.ok) return;
  const errorText = await response.text().catch(() => "");
  const hint =
    response.status === 401 || response.status === 403
      ? " — check that MITHRIL_API_KEY is set and valid for this backend"
      : "";
  throw new Error(`chat request failed (${response.status}): ${errorText}${hint}`);
}

function usageFrom(raw: { prompt_tokens?: unknown; completion_tokens?: unknown } | null | undefined): ChatUsage {
  return {
    promptTokens: typeof raw?.prompt_tokens === "number" ? raw.prompt_tokens : undefined,
    completionTokens: typeof raw?.completion_tokens === "number" ? raw.completion_tokens : undefined,
  };
}

async function parseChatResponse(response: Response): Promise<{ message: ChatMessage; usage: ChatUsage }> {
  interface ChatCompletionResponse {
    choices?: {
      message?: {
        content?: string;
        tool_calls?: ChatMessage["tool_calls"];
      };
    }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  }

  const data: ChatCompletionResponse = await response.json();

  if (!data?.choices?.length || !data.choices[0]?.message) {
    throw new Error("llama-server returned an unexpected response shape (no choices/message).");
  }

  const message = data.choices[0].message;

  return {
    message: {
      role: "assistant",
      content: message.content ?? "",
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    },
    usage: usageFrom(data.usage),
  };
}

// Same as chatOnce, but also returns the server-reported token usage when
// present. Kept separate from the message so the usage never ends up inside
// the conversation history (servers can reject unknown message fields).
export async function chatOnceWithUsage(
  messages: ChatMessage[],
  config: LlamaClientConfig,
  toolDefs?: ApiToolDefinition[]
): Promise<{ message: ChatMessage; usage: ChatUsage }> {
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: buildHeaders(config),
    signal: config.signal ?? null,
    body: chatRequestBody(messages, config, toolDefs, false),
  });

  await failIfNotOk(response);
  return parseChatResponse(response);
}

// Ids for tool calls whose server didn't supply one. Unique per process so
// two steps never reuse an id (history links tool results back by id).
let fallbackCallCounter = 0;

interface CallSlot {
  id: string;
  name: string;
  args: string;
}

// Streaming twin of chatOnceWithUsage: returns the same `{ message, usage }`
// once the stream completes, so the agent loop can treat both identically.
// Answer text is reported through `onToken` as it arrives; tool calls are
// accumulated and only returned whole. Their JSON arguments are never parsed
// here, because a fragment of arguments is not valid JSON.
//
// A stream that ends before the model finished (no finish_reason and no
// [DONE]) throws, so a half-received tool call is never executed.
export async function chatStreamWithUsage(
  messages: ChatMessage[],
  config: LlamaClientConfig,
  toolDefs?: ApiToolDefinition[],
  callbacks: StreamCallbacks = {}
): Promise<{ message: ChatMessage; usage: ChatUsage }> {
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: buildHeaders(config),
    signal: config.signal ?? null,
    body: chatRequestBody(messages, config, toolDefs, true),
  });

  await failIfNotOk(response);

  // Some servers ignore `stream: true` and answer with a plain JSON body.
  // Accept that rather than failing; the whole answer arrives as one token.
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.body || contentType.includes("application/json")) {
    const result = await parseChatResponse(response);
    if (result.message.content) callbacks.onToken?.(result.message.content);
    return result;
  }

  let content = "";
  let usage: ChatUsage = {};
  let finished = false;
  const slots = new Map<number, CallSlot>();

  // Which slot does a tool-call fragment belong to? Normally its `index`.
  // Servers that omit it: a new `id` starts a new call, anything else
  // continues the most recent one.
  const slotIndexFor = (delta: { index?: number | undefined; id?: string | undefined }): number => {
    if (typeof delta.index === "number") return delta.index;
    if (delta.id !== undefined) {
      for (const [i, slot] of slots) if (slot.id === delta.id) return i;
      return slots.size;
    }
    return Math.max(slots.size - 1, 0);
  };

  for await (const payload of sseData(response.body)) {
    if (payload === "[DONE]") {
      finished = true;
      break;
    }

    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      throw new Error(`malformed chunk in model stream: ${payload.slice(0, 120)}`);
    }

    if (chunk.error) {
      const detail = typeof chunk.error === "string" ? chunk.error : (chunk.error.message ?? JSON.stringify(chunk.error));
      throw new Error(`model server reported an error mid-stream: ${detail}`);
    }

    if (chunk.usage) usage = usageFrom(chunk.usage);

    const choice = chunk.choices?.[0];
    if (!choice) continue; // e.g. the trailing usage-only chunk

    // Don't stop reading here: the usage chunk can still follow.
    if (choice.finish_reason) finished = true;

    const delta = choice.delta;
    if (!delta) continue;

    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) callbacks.onReasoning?.(reasoning);

    if (delta.content) {
      content += delta.content;
      callbacks.onToken?.(delta.content);
    }

    for (const fragment of delta.tool_calls ?? []) {
      const index = slotIndexFor(fragment);
      let slot = slots.get(index);
      if (!slot) {
        slot = { id: "", name: "", args: "" };
        slots.set(index, slot);
      }
      if (fragment.id) slot.id = fragment.id;
      if (fragment.function?.name) slot.name += fragment.function.name;
      const args = fragment.function?.arguments;
      if (typeof args === "string") slot.args += args;
      else if (args && typeof args === "object") slot.args = JSON.stringify(args);
    }
  }

  if (!finished) {
    throw new Error("the model stream ended before the model finished (connection dropped?)");
  }

  const tool_calls: ToolCall[] = [...slots.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, slot]) => ({
      id: slot.id || `call_s${++fallbackCallCounter}`,
      type: "function" as const,
      function: {
        name: slot.name,
        // A tool with no parameters may stream no arguments at all.
        arguments: slot.args.trim() === "" ? "{}" : slot.args,
      },
    }));

  return {
    message: {
      role: "assistant",
      content,
      ...(tool_calls.length > 0 ? { tool_calls } : {}),
    },
    usage,
  };
}

export async function chatOnce(
  messages: ChatMessage[],
  config: LlamaClientConfig,
  toolDefs?: ApiToolDefinition[]
): Promise<ChatMessage> {
  return (await chatOnceWithUsage(messages, config, toolDefs)).message;
}

// Calls an embedding-mode llamafile server's /v1/embeddings endpoint and
// returns the embedding vector for a single piece of text.
export async function embedOnce(text: string, config: LlamaClientConfig): Promise<number[]> {
  const response = await fetch(`${config.baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: buildHeaders(config),
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
      headers: buildHeaders(config),
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