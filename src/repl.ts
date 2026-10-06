import { writeFile } from "node:fs/promises";
import * as p from "@clack/prompts";
import type { ChatMessage, Tool } from "./types.js";
import type { LlamaClientConfig } from "./client/llama-client.js";
import { runAgentTurn } from "./agent/agent-loop.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { trimHistory, DEFAULT_MAX_TOKENS } from "./agent/context.js";
import {
  createWriteFileTool,
  createEditFileTool,
  createRunCommandTool,
  type DiffConfirmDetails,
} from "./agent/tools.js";
import { backupRegistry } from "./agent/file-editor.js";

export async function runRepl(config: LlamaClientConfig, tools: Tool[]): Promise<void> {
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

  // Wire interactive confirmation into write_file, edit_file, and run_command tools
  const interactiveTools = tools.map((t) => {
    if (t.name === "write_file") return createWriteFileTool({ confirm: confirmHook });
    if (t.name === "edit_file") return createEditFileTool({ confirm: confirmHook });
    if (t.name === "run_command") return createRunCommandTool({ confirmCommand: confirmCommandHook });
    return t;
  });

  const history: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(interactiveTools) },
  ];

  p.log.message("Type a message, /undo to revert edits, /diff to see modified files, or Ctrl+C to exit.");

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

    history.push({ role: "user", content: userInput });

    // Trim history to stay within the model's context window. The system
    // prompt (index 0) is always preserved; the oldest conversational
    // messages are dropped first.
    const { trimmed, removedCount } = trimHistory(history, DEFAULT_MAX_TOKENS);
    if (removedCount > 0) {
      p.log.warn(`Trimmed ${removedCount} older message(s) to fit the context window.`);
      // Replace the live history with the trimmed version so the dropped
      // messages don't accumulate and get re-trimmed every turn.
      history.length = 0;
      history.push(...trimmed);
    }

    const spin = p.spinner();
    activeSpinner = spin;
    spin.start("Thinking...");

    const reply = await runAgentTurn(history, interactiveTools, config, (toolName) => {
      spin.message(`Calling ${toolName}...`);
    });

    spin.stop("Done.");
    activeSpinner = null;

    // note() draws a titled, bordered panel — gives each reply a clear
    // visual boundary in a scrolling transcript, instead of a plain line
    // that blends into whatever came before it.
    p.note(reply, "mithril");
  }

  p.outro("Goodbye!");
}

