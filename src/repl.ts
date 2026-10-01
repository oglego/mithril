import * as readline from "node:readline/promises";
import type { ChatMessage, Tool } from "./types.js";
import type { LlamaClientConfig } from "./llama-client.js";
import { runAgentTurn } from "./agent-loop.js";

export async function runRepl(config: LlamaClientConfig, tools: Tool[]) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: ChatMessage[] = [];

  console.log("Mithril ready. Type a message (or 'exit' to quit).\n");

  while (true) {
    const userInput = await rl.question("you> ");
    if (userInput.trim().toLowerCase() === "exit") break;

    history.push({ role: "user", content: userInput });
    const reply = await runAgentTurn(history, tools, config);
    console.log("model>", reply, "\n");
  }

  rl.close();
}