import * as p from "@clack/prompts";
import type { ChatMessage, Tool } from "./types.js";
import type { LlamaClientConfig } from "./client/llama-client.js";
import { runAgentTurn } from "./agent/agent-loop.js";

export async function runRepl(config: LlamaClientConfig, tools: Tool[]): Promise<void> {
  const history: ChatMessage[] = [];

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
