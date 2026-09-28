import * as readline from "node:readline/promises";
import type { ChatMessage } from "./types.js";
import { chatStream, type LlamaClientConfig } from "./llama-client.js";

export async function runRepl(config: LlamaClientConfig) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: ChatMessage[] = [];

  console.log("Mithril ready. Type a message (or 'exit' to quit).\n");

  while (true) {
    const userInput = await rl.question("you> ");
    if (userInput.trim().toLowerCase() === "exit") break;

    history.push({ role: "user", content: userInput });

    process.stdout.write("model> ");
    let reply = "";

    for await (const token of chatStream(history, config)) {
      process.stdout.write(token);
      reply += token;
    }
    console.log("\n");

    history.push({ role: "assistant", content: reply });
  }

  rl.close();
}