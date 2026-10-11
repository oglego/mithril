import { ConfigError, parseFlag } from "./config.js";

// Used when nothing better is known. Local: llama-server's common default
// territory for small models. Remote: conservative, because many hosted and
// Ollama setups serve far less than the model's advertised maximum.
export const DEFAULT_LOCAL_WINDOW = 8192;
export const DEFAULT_REMOTE_WINDOW = 16000;

// A detected window can be enormous (a 128k-trained model with `-c 0`).
// Prompts that large are slow and memory-hungry on local hardware, and the
// agent doesn't need them, so the prompt budget is capped here.
export const MAX_AUTO_WINDOW = 32768;
export const MIN_WINDOW = 1024;

export type WindowSource = "flag" | "server" | "default";

export interface ResolvedWindow {
  window: number;
  source: WindowSource;
}

// --context <tokens>, or MITHRIL_CONTEXT. Throws ConfigError on bad input.
export function parseContextFlag(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): number | undefined {
  const fromFlag = parseFlag(argv, "--context");
  if (argv.includes("--context") && fromFlag === undefined) {
    throw new ConfigError("--context requires a number of tokens, e.g. --context 8192.");
  }
  const raw = fromFlag ?? env.MITHRIL_CONTEXT;
  if (raw === undefined || raw === "") return undefined;

  const value = Number(raw.replace(/[_,]/g, ""));
  if (!Number.isInteger(value) || value < MIN_WINDOW) {
    throw new ConfigError(`--context must be a whole number of at least ${MIN_WINDOW} tokens (got "${raw}").`);
  }
  return value;
}

// Asks a llama.cpp-style server for its configured context size (GET /props).
// Field placement has moved between llama.cpp versions, so a few locations are
// tried. Returns null if the server doesn't say; callers then use a default.
export async function fetchServerContextSize(
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 3000
): Promise<number | null> {
  try {
    const response = await fetch(`${baseUrl}/props`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      n_ctx?: unknown;
      default_generation_settings?: { n_ctx?: unknown; params?: { n_ctx?: unknown } };
    };
    const candidates = [
      body.default_generation_settings?.n_ctx,
      body.n_ctx,
      body.default_generation_settings?.params?.n_ctx,
    ];
    for (const c of candidates) {
      if (typeof c === "number" && Number.isInteger(c) && c > 0) return c;
    }
    return null;
  } catch {
    return null;
  }
}

// Precedence: explicit flag > what the server reports > built-in default.
export function resolveContextWindow(input: {
  flag?: number | undefined;
  detected?: number | null | undefined;
  kind: "local" | "remote";
}): ResolvedWindow {
  if (input.flag !== undefined) return { window: input.flag, source: "flag" };
  if (input.detected && input.detected >= MIN_WINDOW) {
    return { window: Math.min(input.detected, MAX_AUTO_WINDOW), source: "server" };
  }
  return { window: input.kind === "local" ? DEFAULT_LOCAL_WINDOW : DEFAULT_REMOTE_WINDOW, source: "default" };
}

export function describeWindow(w: ResolvedWindow): string {
  const how = w.source === "flag" ? "set by --context" : w.source === "server" ? "reported by the server" : "default";
  return `Context window: ${w.window.toLocaleString("en-US")} tokens (${how}).`;
}
