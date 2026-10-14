import { writeFile } from "node:fs/promises";
import * as p from "@clack/prompts";
import type { ChatMessage, Tool } from "./types.js";
import type { LlamaClientConfig } from "./client/llama-client.js";
import { runAgentTurn, type AgentObserver } from "./agent/agent-loop.js";
import { createStreamPrinter, type StreamedCall } from "./agent/stream-printer.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { formatCompactionReport, suggestedWindowFor, type ContextManager } from "./agent/context-manager.js";
import { withMutatingTools, toolsToApiFormat, type DiffConfirmDetails } from "./agent/tools.js";
import { backupRegistry } from "./agent/file-editor.js";

export interface ReplOptions {
  // Show answers as they are generated. On by default; `--no-stream` turns it
  // off for backends whose streaming or tool-call support is unreliable.
  stream?: boolean;
}

export async function runRepl(
  config: LlamaClientConfig,
  tools: Tool[],
  context: ContextManager,
  options: ReplOptions = {}
): Promise<void> {
  const stream = options.stream ?? true;
  // The spinner only exists while we're waiting on something. It is cleared
  // (set to null) while streamed text is being printed, and the confirmation
  // hooks below only pause/resume it when it is running.
  let activeSpinner: ReturnType<typeof p.spinner> | null = null;

  const startSpin = (message: string): void => {
    if (activeSpinner) {
      activeSpinner.message(message);
      return;
    }
    activeSpinner = p.spinner();
    activeSpinner.start(message);
  };

  const stopSpin = (message: string): void => {
    if (!activeSpinner) return;
    const spinner = activeSpinner;
    activeSpinner = null;
    spinner.stop(message);
  };

  const confirmHook = async (details: DiffConfirmDetails): Promise<boolean> => {
    if (activeSpinner) {
      activeSpinner.stop("Proposed code changes:");
    }
    console.log("\n" + details.diff + "\n");
    const confirmed = await p.confirm({
      message: `Apply changes to "${details.relativePath}"?`,
      initialValue: true,
    });
    if (activeSpinner) {
      activeSpinner.start("Resuming...");
    }
    return Boolean(confirmed) && !p.isCancel(confirmed);
  };

  const confirmCommandHook = async (command: string): Promise<boolean> => {
    if (activeSpinner) {
      activeSpinner.stop("Proposed command execution:");
    }
    p.log.message(`Command: \x1b[33m${command}\x1b[0m`);
    const confirmed = await p.confirm({
      message: `Execute command in project root?`,
      initialValue: true,
    });
    if (activeSpinner) {
      activeSpinner.start("Resuming...");
    }
    return Boolean(confirmed) && !p.isCancel(confirmed);
  };

  // write_file, edit_file, and run_command aren't part of the incoming
  // `tools` array at all (see tools.ts) — they're capability-dangerous
  // enough that they must always be constructed with a confirmation
  // callback, so the REPL builds and adds them explicitly here rather than
  // relying on a name-matching swap that could silently be skipped.
  const interactiveTools: Tool[] = withMutatingTools(tools, {
    confirm: confirmHook,
    confirmCommand: confirmCommandHook,
  });

  const history: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(interactiveTools) },
  ];

  p.log.message("Type a message, /undo to revert edits, /diff to see modified files, /context for context usage, or Ctrl+C to exit.");

  // A window barely bigger than the agent's fixed overhead can't hold a
  // conversation. Warn up front instead of failing on the first message.
  {
    const fixed = context.fixedPromptTokens(history, toolsToApiFormat(interactiveTools));
    if (fixed > context.maxInputTokens * 0.6) {
      p.log.warn(
        `The system prompt and tools use ~${fixed} tokens, leaving little room in a ${context.contextWindow}-token window. ` +
          `Use --context ${suggestedWindowFor(fixed)} or larger for a usable session.`
      );
    }
  }

  while (true) {
    const userInput = await p.text({
      message: "You",
      placeholder: "Ask something...",
    });

    // Ctrl+C during the prompt resolves with a cancel symbol rather than
    // throwing — same pattern as the model picker, so exiting feels
    // consistent whether you're at the picker or mid-conversation.
    if (p.isCancel(userInput)) break;
    if (userInput.trim().toLowerCase() === "exit") break;
    if (userInput.trim().length === 0) continue;

    // --- Slash Commands ---
    if (userInput.trim().toLowerCase() === "/undo") {
      const backup = backupRegistry.pop();
      if (!backup) {
        p.log.warn("No modified files in history to undo.");
        continue;
      }
      try {
        await writeFile(backup.filePath, backup.content, "utf-8");
        p.log.success(`Reverted changes to "${backup.relativePath}".`);
      } catch (err) {
        p.log.error(`Failed to revert "${backup.relativePath}": ${(err as Error).message}`);
      }
      continue;
    }

    if (userInput.trim().toLowerCase() === "/diff") {
      const historyList = backupRegistry.list();
      if (historyList.length === 0) {
        p.log.info("No files have been modified in this session.");
        continue;
      }
      p.log.info(`Files modified in this session (${historyList.length}):`);
      for (const item of historyList) {
        p.log.message(`- ${item.relativePath} (${new Date(item.timestamp).toLocaleTimeString()})`);
      }
      continue;
    }

    if (userInput.trim().toLowerCase() === "/context") {
      p.log.message(context.describe(history, toolsToApiFormat(interactiveTools)));
      continue;
    }

    history.push({ role: "user", content: userInput });

    startSpin("Thinking...");

    // Compaction now happens inside the agent loop (before every model call).
    // Notices are collected and printed after the spinner stops, so they
    // don't garble the spinner line.
    const notices: string[] = [];

    // Streaming: tokens are printed as they arrive. The spinner stops when
    // the first one is shown and comes back for tool calls.
    let headerShown = false;
    let announcedReasoning = false;
    const printer = createStreamPrinter((text) => {
      stopSpin("");
      if (!headerShown) {
        process.stdout.write("\x1b[36m◆ mithril\x1b[0m\n");
        headerShown = true;
      }
      process.stdout.write(text);
    });
    let lastCall: StreamedCall = { text: "", shown: false };

    const endCall = (): void => {
      lastCall = printer.finish();
      if (lastCall.shown) process.stdout.write("\n");
      headerShown = false;
      announcedReasoning = false;
    };

    const observer: AgentObserver | undefined = stream
      ? {
          onToken: (token) => printer.push(token),
          onReasoning: () => {
            // Reasoning isn't shown; just tell the user the model is working.
            if (!announcedReasoning) {
              announcedReasoning = true;
              if (activeSpinner) activeSpinner.message("Reasoning...");
            }
          },
          onModelCall: endCall,
        }
      : undefined;

    const reply = await runAgentTurn(
      history,
      interactiveTools,
      config,
      (toolName) => {
        startSpin(`Calling ${toolName}...`);
      },
      undefined,
      {
        manager: context,
        onCompact: (report) => {
          notices.push(formatCompactionReport(report));
          startSpin("Compacting context...");
        },
      },
      observer
    );

    // A call that failed part-way never reports back; flush whatever it showed.
    if (stream) endCall();
    stopSpin("Done.");
    for (const notice of notices) p.log.info(notice);

    // Streamed answers are already on screen. Everything else (non-streaming
    // mode, stop messages, errors) goes in a titled, bordered panel — a clear
    // visual boundary in a scrolling transcript.
    const alreadyShown = lastCall.shown && lastCall.text.trim() === reply.trim();
    if (!alreadyShown) p.note(reply, "mithril");
  }

  p.outro("Goodbye!");
}

