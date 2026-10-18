import * as p from "@clack/prompts";
import { LlamafileManager } from "./llamafile/manager.js";
import { selectBackend } from "./models/onboarding.js";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { ConfigError, parsePortFlag, resolveBackend, probeBackend } from "./config.js";
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

// Starts a llamafile as the chat server and waits until it is ready. Shared by
// the model picker, --llamafile and headless mode, so a model is always
// launched the same way. The manager is registered for cleanup before it
// starts, so even a failed start is stopped by stopAll().
export async function launchLlamafile(options: {
  binaryPath: string;
  modelId: string;
  port: number;
  contextFlag: number | undefined;
  onStatus: (message: string) => void;
  logPath?: string;
}): Promise<StartedBackend> {
  if (!existsSync(options.binaryPath) || !statSync(options.binaryPath).isFile()) {
    throw new ConfigError(`--llamafile: no such file: ${options.binaryPath}`);
  }

  const baseUrl = `http://localhost:${options.port}`;
  const llamafile = new LlamafileManager({
    binaryPath: options.binaryPath,
    port: options.port,
    // These binaries are new enough for --no-webui. -c is only passed when
    // the user asked for a specific window; otherwise the server's own
    // setting is detected after startup.
    extraArgs: ["--jinja", "--no-webui", ...(options.contextFlag ? ["-c", String(options.contextFlag)] : [])],
    logPath: options.logPath ?? "./mithril.log",
    name: "chat model",
    onStatus: options.onStatus,
  });

  managers.push(llamafile);
  await llamafile.start();

  const detected = options.contextFlag ? null : await fetchServerContextSize(baseUrl);
  return {
    chatConfig: { baseUrl, model: options.modelId },
    contextWindow: resolveContextWindow({ flag: options.contextFlag, detected, kind: "local" }),
  };
}

// Resolves and starts whichever chat backend the user asked for: a remote
// OpenAI-compatible server (--base-url), a llamafile to launch (--llamafile),
// or the interactive picker, which can download and launch a local llamafile
// or connect to a server. Shared by the
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
  } else if (backend.kind === "llamafile") {
    // A llamafile the user already has: no picker, no download.
    ({ chatConfig, contextWindow } = await launchLlamafile({
      binaryPath: backend.path,
      modelId: path.basename(backend.path),
      port: parsePortFlag(argv),
      contextFlag,
      onStatus: (message) => p.log.step(message),
    }));
  } else {
    const selection = await selectBackend();

    if (selection.kind === "remote") {
      // Picked "Connect to a server…" in the model picker. The setup flow has
      // already contacted the server, so no second probe here.
      p.log.info(`Using remote backend ${selection.baseUrl} (model: ${selection.model}).`);
      chatConfig = { baseUrl: selection.baseUrl, model: selection.model, apiKey: selection.apiKey };
      contextWindow = resolveContextWindow({ flag: contextFlag, kind: "remote" });
    } else {
      ({ chatConfig, contextWindow } = await launchLlamafile({
        binaryPath: selection.binaryPath,
        modelId: selection.modelId,
        port: parsePortFlag(argv),
        contextFlag,
        onStatus: (message) => p.log.step(message),
      }));
    }
  }

  return { chatConfig, contextWindow };
}
