import path from "node:path";

// Where the chat model lives. "local" is the original behavior (pick a
// llamafile from the catalog, download it, spawn it). "remote" points Mithril
// at any OpenAI-compatible server that is already running — Ollama,
// LM Studio, llama-server, vLLM, OpenRouter, OpenAI, etc.
export type BackendConfig =
  // No flags: the interactive picker chooses (or downloads) a model.
  | { kind: "local" }
  // --llamafile <path>: Mithril starts this llamafile itself, with no picker.
  | { kind: "llamafile"; path: string }
  // --base-url/--model: an OpenAI-compatible server that is already running.
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

// The port Mithril starts a llamafile on, unless --port says otherwise.
export const DEFAULT_LLAMAFILE_PORT = 8080;

export function parsePortFlag(argv: string[]): number {
  if (!argv.includes("--port")) return DEFAULT_LLAMAFILE_PORT;
  const raw = parseFlag(argv, "--port");
  const port = Number(raw);
  if (raw === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`--port must be a whole number from 1 to 65535 (got ${raw === undefined ? "nothing" : `"${raw}"`}).`);
  }
  return port;
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
//   --llamafile <path> start this llamafile as the model server (no picker);
//                      --port <n> chooses its port (default 8080)
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

  parsePortFlag(argv); // validated up front, before anything is downloaded or started

  if (argv.includes("--llamafile")) {
    const file = parsePathFlag(argv, "--llamafile");
    if (!file) throw new ConfigError("--llamafile needs the path to a .llamafile.");
    // Only the flags count here: an exported MITHRIL_BASE_URL must not stop
    // someone from pointing at a file on one command.
    if (argv.includes("--base-url") || argv.includes("--model")) {
      throw new ConfigError("--llamafile starts its own server, so it can't be combined with --base-url or --model.");
    }
    return { kind: "llamafile", path: file };
  }

  const rawBaseUrl = parseFlag(argv, "--base-url") ?? env.MITHRIL_BASE_URL;
  const model = parseFlag(argv, "--model") ?? env.MITHRIL_MODEL;

  if (rawBaseUrl && argv.includes("--port")) {
    throw new ConfigError(`--port only applies when Mithril starts the model itself (the picker or --llamafile); it can't change where ${rawBaseUrl} listens.`);
  }

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

export interface ModelListing {
  ids: string[];
  // Set when something looks wrong (unreachable, bad credentials). The caller
  // decides how loudly to surface it; a listing failure is never fatal.
  warning: string | null;
}

// Asks an OpenAI-compatible server which models it serves (GET /v1/models).
// Never throws. Ollama, LM Studio, vLLM and the hosted providers implement
// this; a server that doesn't just yields an empty list with no warning, since
// it's still reachable and the user can type a model name by hand.
export async function fetchModelIds(
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 5000
): Promise<ModelListing> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ids: [],
        warning: `Server at ${baseUrl} rejected the credentials (${response.status}). Check your API key.`,
      };
    }
    if (!response.ok) return { ids: [], warning: null };

    const body: unknown = await response.json().catch(() => null);
    const data = (body as { data?: unknown } | null)?.data;
    const ids = Array.isArray(data)
      ? data.flatMap((m) => (typeof (m as { id?: unknown })?.id === "string" ? [(m as { id: string }).id] : []))
      : [];
    return { ids: [...new Set(ids)].sort((a, b) => a.localeCompare(b)), warning: null };
  } catch (err) {
    return { ids: [], warning: `Could not reach ${baseUrl} (${(err as Error).message}). Is the server running?` };
  }
}

// Best-effort reachability probe for remote backends: returns a warning
// string if something looks wrong, or null if the server answered.
export async function probeBackend(baseUrl: string, apiKey?: string, timeoutMs = 5000): Promise<string | null> {
  return (await fetchModelIds(baseUrl, apiKey, timeoutMs)).warning;
}
