import { writeFile } from "node:fs/promises";
import * as p from "@clack/prompts";
import type { ChatMessage, Tool } from "./types.js";
import type { LlamaClientConfig } from "./client/llama-client.js";
import { runAgentTurn } from "./agent/agent-loop.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { formatCompactionReport, suggestedWindowFor, type ContextManager } from "./agent/context-manager.js";
import { withMutatingTools, toolsToApiFormat, type DiffConfirmDetails } from "./agent/tools.js";
import { backupRegistry } from "./agent/file-editor.js";

export async function runRepl(config: LlamaClientConfig, tools: Tool[], context: ContextManager): Promise<void> {
  let activeSpinner: ReturnType<typeof p.spinner> | null = null;

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

    const spin = p.spinner();
    activeSpinner = spin;
    spin.start("Thinking...");

    // Compaction now happens inside the agent loop (before every model call).
    // Notices are collected and printed after the spinner stops, so they
    // don't garble the spinner line.
    const notices: string[] = [];
    const reply = await runAgentTurn(
      history,
      interactiveTools,
      config,
      (toolName) => {
        spin.message(`Calling ${toolName}...`);
      },
      undefined,
      {
        manager: context,
        onCompact: (report) => {
          notices.push(formatCompactionReport(report));
          spin.message("Compacting context...");
        },
      }
    );

    spin.stop("Done.");
    activeSpinner = null;
    for (const notice of notices) p.log.info(notice);

    // note() draws a titled, bordered panel — gives each reply a clear
    // visual boundary in a scrolling transcript, instead of a plain line
    // that blends into whatever came before it.
    p.note(reply, "mithril");
  }

  p.outro("Goodbye!");
}

