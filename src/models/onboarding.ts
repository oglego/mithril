import * as p from "@clack/prompts";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ModelInfo } from "./catalog.js";
import { loadCatalog, mergeInstalledModels } from "./catalog-source.js";
import { downloadFile } from "./downloader.js";
import { getModelsDir } from "./paths.js";
import { runRemoteSetup, type RemoteSelection } from "./remote-setup.js";

export type SelectedBackend =
  | { kind: "local"; binaryPath: string; modelId: string }
  | ({ kind: "remote" } & RemoteSelection);

// Sentinel for the extra picker entry that switches to remote setup.
const REMOTE = "remote" as const;

function originNote(origin: string): string | null {
  switch (origin) {
    case "live":
      return "Model list updated from Hugging Face.";
    case "stale-cache":
      return "Couldn't reach Hugging Face — showing the last downloaded model list.";
    case "fallback":
      return "Couldn't reach Hugging Face — showing Mithril's built-in model list.";
    default:
      return null; // fresh cache: nothing worth saying
  }
}

export async function selectBackend(): Promise<SelectedBackend> {
  const MODELS_DIR = getModelsDir();

  const spin = p.spinner();
  spin.start("Loading model list...");
  const { models: catalog, origin } = await loadCatalog({
    cachePath: path.join(MODELS_DIR, ".catalog-cache.json"),
  });
  const models = await mergeInstalledModels(catalog, MODELS_DIR);
  spin.stop("Model list ready.");
  const note = originNote(origin);
  if (note) p.log.info(note);

  const choice = await p.select<ModelInfo | typeof REMOTE>({
    message: "Which model do you want to run?",
    options: [
      ...models.map((m) => {
        const installed = existsSync(path.join(MODELS_DIR, m.filename));
        const hint = [m.size, m.license, installed ? "downloaded" : undefined].filter(Boolean).join(" · ");
        return { value: m, label: m.name, hint };
      }),
      {
        value: REMOTE,
        label: "Connect to a server…",
        hint: "Ollama, LM Studio, OpenAI, or any OpenAI-compatible API",
      },
    ],
  });

  // If the user hits Ctrl+C during the prompt, select() returns a special
  // "cancel" symbol instead of throwing — isCancel() checks for that.
  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  if (choice === REMOTE) {
    return { kind: "remote", ...(await runRemoteSetup()) };
  }

  if (!existsSync(MODELS_DIR)) mkdirSync(MODELS_DIR);

  const destPath = path.join(MODELS_DIR, choice.filename);
  // llamafile identifies its loaded model by this id in API responses;
  // stripping the extension gives a reasonable, stable identifier to send.
  const modelId = choice.filename.replace(/\.llamafile$/, "");

  if (existsSync(destPath)) {
    p.log.info(`${choice.name} is already downloaded — skipping.`);
    return { kind: "local", binaryPath: destPath, modelId };
  }

  const dl = p.spinner();
  dl.start(`Downloading ${choice.name} (${choice.size})...`);

  await downloadFile(choice.url, destPath, (percent) => {
    dl.message(`Downloading ${choice.name}... ${percent}%`);
  });

  dl.stop(`${choice.name} downloaded.`);

  return { kind: "local", binaryPath: destPath, modelId };
}
