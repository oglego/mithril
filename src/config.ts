import path from "node:path";

// Where the chat model lives. "local" is the original behavior (pick a
// llamafile from the catalog, download it, spawn it). "remote" points Mithril
// at any OpenAI-compatible server that is already running — Ollama,
// LM Studio, llama-server, vLLM, OpenRouter, OpenAI, etc.
export type BackendConfig =
  | { kind: "local" }
  | { kind: "remote"; baseUrl: string; model: string; apiKey?: string | undefined };

export class ConfigError extends Error {}

// Looks for `--<flag> <value>` in argv. Returns undefined if the flag is
// absent or has no value (including when the next token is another flag).
export function parseFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  const value = i !== -1 ? argv[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

export function parsePathFlag(argv: string[], flag: string): string | undefined {
  const value = parseFlag(argv, flag);
  return value ? path.resolve(value) : undefined;
}

// The client appends "/v1/chat/completions" itself, but most hosted
// providers document their base URL *with* the "/v1" (or a similar version
// segment) already on it. Strip a trailing "/v1" and any trailing slashes so
// both styles work and we never request ".../v1/v1/...".
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`--base-url "${raw}" is not a valid URL (expected e.g. http://localhost:11434).`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`--base-url must start with http:// or https:// (got "${url.protocol}//").`);
  }
  const trimmed = url.toString().replace(/\/+$/, "").replace(/\/v1$/, "");
  return trimmed;
}

// Resolves which backend to use from CLI flags and environment.
//
//   --base-url <url>   use a remote/already-running OpenAI-compatible server
//   --model <id>       model name to send (required with --base-url)
//
// The API key is deliberately NOT a CLI flag: command-line arguments end up
// in shell history and `ps` output. It's read from MITHRIL_API_KEY, falling
// back to OPENAI_API_KEY.
export function resolveBackend(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): BackendConfig {
  if (argv.includes("--api-key")) {
    throw new ConfigError(
      "--api-key is not supported (it would leak into shell history and process listings). " +
        "Set the MITHRIL_API_KEY environment variable instead."
    );
  }

  const rawBaseUrl = parseFlag(argv, "--base-url") ?? env.MITHRIL_BASE_URL;
  const model = parseFlag(argv, "--model") ?? env.MITHRIL_MODEL;

  if (!rawBaseUrl) {
    // --model alone is ambiguous in local mode (the picker chooses the model).
    if (argv.includes("--model")) {
      throw new ConfigError("--model only applies together with --base-url.");
    }
    return { kind: "local" };
  }

  if (!model) {
    throw new ConfigError("--base-url requires --model <id> (the model name your server expects).");
  }

  const apiKey = env.MITHRIL_API_KEY || env.OPENAI_API_KEY || undefined;
  return { kind: "remote", baseUrl: normalizeBaseUrl(rawBaseUrl), model, apiKey };
}

// Best-effort reachability probe for remote backends. Returns a warning
// string if something looks wrong, or null if the server answered. Never
// throws: some providers don't implement /v1/models, so a failure here
// should inform the user, not block startup.
export async function probeBackend(
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 5000
): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      return `Server at ${baseUrl} rejected the credentials (${response.status}). Check MITHRIL_API_KEY.`;
    }
    return null; // 200, or 404 from providers without /v1/models — either way it's reachable
  } catch (err) {
    return `Could not reach ${baseUrl} (${(err as Error).message}). Is the server running?`;
  }
}
