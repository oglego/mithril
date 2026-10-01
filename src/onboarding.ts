import * as p from "@clack/prompts";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { MODEL_CATALOG } from "./models.js";
import { downloadFile } from "./downloader.js";
import { MODELS_DIR } from "./paths.js";

export interface PreparedModel {
  binaryPath: string;
  modelId: string;
}

export async function selectAndPrepareModel(): Promise<PreparedModel> {
  p.intro("Mithril — local model harness");

  const choice = await p.select({
    message: "Which model do you want to run?",
    options: MODEL_CATALOG.map((m) => ({
      value: m,
      label: m.name,
      hint: `${m.size} · ${m.license}`,
    })),
  });

  // If the user hits Ctrl+C during the prompt, select() returns a special
  // "cancel" symbol instead of throwing — isCancel() checks for that.
  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  if (!existsSync(MODELS_DIR)) mkdirSync(MODELS_DIR);

  const destPath = path.join(MODELS_DIR, choice.filename);
  // llamafile identifies its loaded model by this id in API responses;
  // stripping the extension gives a reasonable, stable identifier to send.
  const modelId = choice.filename.replace(/\.llamafile$/, "");

  if (existsSync(destPath)) {
    p.log.info(`${choice.name} is already downloaded — skipping.`);
    p.outro("Ready.");
    return { binaryPath: destPath, modelId };
  }

  const spin = p.spinner();
  spin.start(`Downloading ${choice.name} (${choice.size})...`);

  await downloadFile(choice.url, destPath, (percent) => {
    spin.message(`Downloading ${choice.name}... ${percent}%`);
  });

  spin.stop(`${choice.name} downloaded.`);
  p.outro("Ready.");

  return { binaryPath: destPath, modelId };
}