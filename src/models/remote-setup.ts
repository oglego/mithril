import * as p from "@clack/prompts";
import { normalizeBaseUrl, fetchModelIds, ConfigError } from "../config.js";

export interface RemoteSelection {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
}

export interface RemotePreset {
  id: string;
  label: string;
  hint: string;
  baseUrl?: string; // omitted for the "custom" entry
  needsKey: boolean;
}

// Base URLs are given WITHOUT a trailing /v1 — the client appends
// /v1/chat/completions itself (config.normalizeBaseUrl enforces this).
export const REMOTE_PRESETS: RemotePreset[] = [
  { id: "ollama", label: "Ollama", hint: "http://localhost:11434", baseUrl: "http://localhost:11434", needsKey: false },
  { id: "lmstudio", label: "LM Studio", hint: "http://localhost:1234", baseUrl: "http://localhost:1234", needsKey: false },
  { id: "openai", label: "OpenAI", hint: "api.openai.com", baseUrl: "https://api.openai.com", needsKey: true },
  { id: "openrouter", label: "OpenRouter", hint: "openrouter.ai", baseUrl: "https://openrouter.ai/api", needsKey: true },
  { id: "custom", label: "Other OpenAI-compatible server…", hint: "enter a URL", needsKey: false },
];

// Same cancel convention as the model picker: Ctrl+C at any prompt exits
// cleanly instead of throwing.
function orExit<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}

// Interactive flow for connecting to a server that is already running (or a
// hosted API). Walks through: which server -> URL -> API key -> model. The key
// is never written to disk; it lives in memory for this session only.
export async function runRemoteSetup(env: Record<string, string | undefined> = process.env): Promise<RemoteSelection> {
  const preset = orExit(
    await p.select({
      message: "Which server do you want to connect to?",
      options: REMOTE_PRESETS.map((r) => ({ value: r, label: r.label, hint: r.hint })),
    })
  );

  const rawUrl = orExit(
    await p.text({
      message: "Server URL",
      initialValue: preset.baseUrl ?? "http://localhost:",
      validate: (value) => {
        try {
          normalizeBaseUrl(value ?? "");
          return undefined;
        } catch (err) {
          return err instanceof ConfigError ? err.message : "Invalid URL.";
        }
      },
    })
  );
  const baseUrl = normalizeBaseUrl(rawUrl);

  // An environment key wins silently (and is announced, so it's never a
  // surprise which credential is in use). Otherwise ask — but only insist
  // for providers that need one; local servers accept an empty answer.
  let apiKey: string | undefined = env.MITHRIL_API_KEY || env.OPENAI_API_KEY || undefined;
  if (apiKey) {
    p.log.info("Using API key from the MITHRIL_API_KEY / OPENAI_API_KEY environment variable.");
  } else {
    const entered = orExit(
      await p.password({
        message: preset.needsKey ? "API key" : "API key (leave empty if the server doesn't need one)",
        validate: (value) => (preset.needsKey && !value ? "This provider requires an API key." : undefined),
      })
    );
    apiKey = entered || undefined;
  }

  const spin = p.spinner();
  spin.start(`Contacting ${baseUrl}...`);
  const listing = await fetchModelIds(baseUrl, apiKey);
  spin.stop(listing.warning ? "Could not list models." : `Found ${listing.ids.length} model(s).`);
  if (listing.warning) p.log.warn(listing.warning);

  const MANUAL = "__manual__";
  let model: string | undefined;

  if (listing.ids.length > 0) {
    const choice = orExit(
      await p.select({
        message: "Which model?",
        maxItems: 10,
        options: [
          ...listing.ids.map((id) => ({ value: id, label: id })),
          { value: MANUAL, label: "Enter a model name manually…" },
        ],
      })
    );
    if (choice !== MANUAL) model = choice;
  }

  if (!model) {
    model = orExit(
      await p.text({
        message: "Model name",
        placeholder: "e.g. qwen3:8b",
        validate: (value) => (value && value.trim().length > 0 ? undefined : "A model name is required."),
      })
    ).trim();
  }

  return { baseUrl, model, apiKey };
}
