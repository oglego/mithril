import * as p from "@clack/prompts";
import type { ChatMessage, Tool } from "./types.js";
import type { LlamaClientConfig } from "./client/llama-client.js";
import { runAgentTurn } from "./agent/agent-loop.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { trimHistory, DEFAULT_MAX_TOKENS } from "./agent/context.js";

export async function runRepl(config: LlamaClientConfig, tools: Tool[]): Promise<void> {
  const history: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(tools) },
  ];

  p.log.message("Type a message, or press Ctrl+C to exit.");

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
    spin.start("Thinking...");

    const reply = await runAgentTurn(history, tools, config, (toolName) => {
      spin.message(`Calling ${toolName}...`);
    });

    spin.stop("Done.");

    // note() draws a titled, bordered panel — gives each reply a clear
    // visual boundary in a scrolling transcript, instead of a plain line
    // that blends into whatever came before it.
    p.note(reply, "mithril");
  }

  p.outro("Goodbye!");
}

