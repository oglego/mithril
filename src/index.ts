import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import * as p from "@clack/prompts";
import { runRepl } from "./repl.js";
import { LlamafileManager } from "./llamafile/manager.js";
import { selectAndPrepareModel } from "./models/onboarding.js";
import { getModelsDir } from "./models/paths.js";
import { EMBEDDING_MODEL } from "./models/embedding-model.js";
import { downloadFile } from "./models/downloader.js";
import { buildIndex } from "./rag/indexer.js";
import { createSearchDocsTool } from "./rag/rag-tool.js";
import { tools as baseTools } from "./agent/tools.js";
import { loadSkills } from "./skills/loader.js";
import { createLoadSkillTool } from "./skills/skill-tool.js";
import { BANNER } from "./banner.js";
import type { Tool } from "./types.js";

// Looks for `--<flag> <path>` in the CLI args, resolved to an absolute path.
// Kept as manual parsing rather than pulling in a CLI-args library — there
// are only two flags to support.
function parseFlagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  const value = i !== -1 ? argv[i + 1] : undefined;
  return value ? path.resolve(value) : undefined;
}

// Every LlamafileManager we start needs to be stopped no matter how the app
// ends — a failed download, a crash mid-startup, a normal "exit", or a
// Ctrl+C inside the chat prompt should all lead here. Node doesn't kill
// spawned child processes just because the parent exits, throws, or a
// clack prompt intercepts Ctrl+C before it becomes a process signal — so
// every exit path below calls this explicitly, rather than relying on any
// one of them to catch every case.
const managers: LlamafileManager[] = [];

function stopAll(): void {
  for (const manager of managers) manager.stop();
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error(`Mithril hit an unexpected error: ${err.message}`);
  stopAll();
  process.exit(1);
});

console.log(BANNER);
p.intro("------------------------------------------------------------");

try {
  const MODELS_DIR = getModelsDir();
  const { binaryPath, modelId } = await selectAndPrepareModel();

  const llamafile = new LlamafileManager({
    binaryPath,
    port: 8080,
    extraArgs: ["--jinja", "--no-webui"], // this catalog's binaries are new enough for --no-webui
    logPath: "./mithril.log",
    name: "chat model",
    onStatus: (message) => p.log.step(message),
  });

  // Pushed before start() so a failed start() still gets cleaned up by catch.
  managers.push(llamafile);
  await llamafile.start();

  let tools: Tool[] = baseTools;

  const argv = process.argv.slice(2);
  const docsDir = parseFlagValue(argv, "--docs");

  if (docsDir) {
    if (!existsSync(MODELS_DIR)) mkdirSync(MODELS_DIR);

    const embeddingBinaryPath = path.join(MODELS_DIR, EMBEDDING_MODEL.filename);

    if (!existsSync(embeddingBinaryPath)) {
      const spin = p.spinner();
      spin.start(`Downloading embedding model (${EMBEDDING_MODEL.size})...`);
      await downloadFile(EMBEDDING_MODEL.url, embeddingBinaryPath, (percent) => {
        spin.message(`Downloading embedding model... ${percent}%`);
      });
      spin.stop("Embedding model downloaded.");
    }

    const embeddingManager = new LlamafileManager({
      binaryPath: embeddingBinaryPath,
      port: 8081,
      // This specific model file was built against an older llamafile release
      // that predates the --nobrowser -> --no-webui rename, so it needs the
      // older flag name. If Mozilla ships a newer build of this model later,
      // this may need to flip to --no-webui — check with --help if launch fails.
      extraArgs: ["--embedding", "--nobrowser"],
      logPath: "./mithril-embedding.log",
      name: "embedding model",
      onStatus: (message) => p.log.step(message),
    });

    managers.push(embeddingManager);
    await embeddingManager.start();

    const embeddingConfig = {
      baseUrl: "http://localhost:8081",
      model: EMBEDDING_MODEL.filename,
      queryPrefix: EMBEDDING_MODEL.queryPrefix,
    };

    p.log.info(`Indexing markdown files in ${docsDir}...`);
    const index = await buildIndex(docsDir, embeddingConfig, (message) => p.log.info(message));
    p.log.info(`Indexed ${index.length} chunk(s) from ${docsDir}.`);

    tools = [...baseTools, createSearchDocsTool(index, docsDir, embeddingConfig)];
  }

  const skillsDir = parseFlagValue(argv, "--skills");

  if (skillsDir) {
    p.log.info(`Loading skills from ${skillsDir}...`);
    const skills = await loadSkills(skillsDir);

    if (skills.length > 0) {
      p.log.info(`Loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
      tools = [...tools, createLoadSkillTool(skills)];
    } else {
      p.log.warn(`No SKILL.md files found in ${skillsDir}.`);
    }
  }

  await runRepl({ baseUrl: "http://localhost:8080", model: modelId }, tools);

  // Normal exit path (typed "exit", or Ctrl+C inside the chat prompt, which
  // clack intercepts as a cancel rather than a process-level SIGINT).
  stopAll();
  process.exit(0);
} catch (err) {
  console.error(`Mithril failed to start: ${(err as Error).message}`);
  stopAll();
  process.exit(1);
}
