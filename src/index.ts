import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import * as p from "@clack/prompts";
import { runRepl } from "./repl.js";
import { LlamafileManager } from "./llamafile/manager.js";
import { getModelsDir } from "./models/paths.js";
import { EMBEDDING_MODEL } from "./models/embedding-model.js";
import { downloadFile } from "./models/downloader.js";
import { buildIndex } from "./rag/indexer.js";
import { createSearchDocsTool } from "./rag/rag-tool.js";
import { tools as baseTools } from "./agent/tools.js";
import { loadSkills } from "./skills/loader.js";
import { createLoadSkillTool } from "./skills/skill-tool.js";
import { BANNER } from "./banner.js";
import { parsePathFlag, ConfigError } from "./config.js";
import { startBackend, installExitHandlers, managers, stopAll } from "./backend.js";
import type { Tool } from "./types.js";
import { ContextManager } from "./agent/context-manager.js";
import { describeWindow } from "./context-window.js";

// `mithril eval ...` runs the evaluation harness instead of the chat app.
if (process.argv[2] === "eval") {
  try {
    const { runEvalCli } = await import("./eval/cli.js");
    const code = await runEvalCli(process.argv.slice(3));
    stopAll();
    process.exit(code);
  } catch (err) {
    console.error(`mithril eval failed: ${(err as Error).message}`);
    stopAll();
    process.exit(1);
  }
}

// The chat app quits immediately on Ctrl+C. `mithril eval` installs its own
// handlers instead, so that an interrupted run can save what it has measured.
installExitHandlers();

console.log(BANNER);
p.intro("------------------------------------------------------------");

try {
  const MODELS_DIR = getModelsDir();
  const argv = process.argv.slice(2);
  const { chatConfig, contextWindow } = await startBackend(argv);

  p.log.info(describeWindow(contextWindow));
  const context = new ContextManager({ contextWindow: contextWindow.window });

  let tools: Tool[] = baseTools;

  const docsDir = parsePathFlag(argv, "--docs");

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

  const skillsDir = parsePathFlag(argv, "--skills");

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

  await runRepl(chatConfig, tools, context);

  // Normal exit path (typed "exit", or Ctrl+C inside the chat prompt, which
  // clack intercepts as a cancel rather than a process-level SIGINT).
  stopAll();
  process.exit(0);
} catch (err) {
  const prefix = err instanceof ConfigError ? "Mithril configuration error" : "Mithril failed to start";
  console.error(`${prefix}: ${(err as Error).message}`);
  stopAll();
  process.exit(1);
}
