import * as p from "@clack/prompts";
import { LlamafileManager } from "./llamafile/manager.js";
import { selectBackend } from "./models/onboarding.js";
import { resolveBackend, probeBackend } from "./config.js";
import type { LlamaClientConfig } from "./client/llama-client.js";
import {
  parseContextFlag,
  fetchServerContextSize,
  resolveContextWindow,
  type ResolvedWindow,
} from "./context-window.js";

// Every LlamafileManager we start needs to be stopped no matter how the app
// ends — a failed download, a crash mid-startup, a normal "exit", or a
// Ctrl+C inside the chat prompt should all lead here. Node doesn't kill
// spawned child processes just because the parent exits, throws, or a
// clack prompt intercepts Ctrl+C before it becomes a process signal — so
// every exit path below calls this explicitly, rather than relying on any
// one of them to catch every case.
export const managers: LlamafileManager[] = [];

export function stopAll(): void {
  for (const manager of managers) manager.stop();
}

let handlersInstalled = false;

export function installExitHandlers(): void {
  if (handlersInstalled) return; // idempotent: callers may be reached more than once per process
  handlersInstalled = true;
  process.on("SIGINT", () => {
    stopAll();
    process.exit(0);
  });

  process.on("uncaughtException", (err) => {
    console.error(`Mithril hit an unexpected error: ${err.message}`);
    stopAll();
    process.exit(1);
  });
}

export interface StartedBackend {
  chatConfig: LlamaClientConfig;
  contextWindow: ResolvedWindow;
}

// Resolves and starts whichever chat backend the user asked for: a remote
// OpenAI-compatible server (--base-url), or the interactive picker, which can
// download and launch a local llamafile or connect to a server. Shared by the
// chat app and `mithril eval` so both always run the model the same way.
export async function startBackend(argv: string[]): Promise<StartedBackend> {
  const backend = resolveBackend(argv);

  const contextFlag = parseContextFlag(argv);
  let chatConfig: LlamaClientConfig;
  let contextWindow: ResolvedWindow;

  if (backend.kind === "remote") {
    // Remote mode: no catalog picker, no download, no local server. Mithril
    // talks to whatever OpenAI-compatible endpoint the user pointed it at.
    p.log.info(`Using remote backend ${backend.baseUrl} (model: ${backend.model}).`);
    const warning = await probeBackend(backend.baseUrl, backend.apiKey);
    if (warning) p.log.warn(warning);
    chatConfig = { baseUrl: backend.baseUrl, model: backend.model, apiKey: backend.apiKey };
    contextWindow = resolveContextWindow({ flag: contextFlag, kind: "remote" });
  } else {
    const selection = await selectBackend();

    if (selection.kind === "remote") {
      // Picked "Connect to a server…" in the model picker. The setup flow has
      // already contacted the server, so no second probe here.
      p.log.info(`Using remote backend ${selection.baseUrl} (model: ${selection.model}).`);
      chatConfig = { baseUrl: selection.baseUrl, model: selection.model, apiKey: selection.apiKey };
      contextWindow = resolveContextWindow({ flag: contextFlag, kind: "remote" });
    } else {
      const llamafile = new LlamafileManager({
        binaryPath: selection.binaryPath,
        port: 8080,
        // this catalog's binaries are new enough for --no-webui. -c is only
        // passed when the user asked for a specific window; otherwise the
        // server's own setting is detected after startup.
        extraArgs: ["--jinja", "--no-webui", ...(contextFlag ? ["-c", String(contextFlag)] : [])],
        logPath: "./mithril.log",
        name: "chat model",
        onStatus: (message) => p.log.step(message),
      });

      // Pushed before start() so a failed start() still gets cleaned up by catch.
      managers.push(llamafile);
      await llamafile.start();
      chatConfig = { baseUrl: "http://localhost:8080", model: selection.modelId };
      const detected = contextFlag ? null : await fetchServerContextSize("http://localhost:8080");
      contextWindow = resolveContextWindow({ flag: contextFlag, detected, kind: "local" });
    }
  }

  return { chatConfig, contextWindow };
}
