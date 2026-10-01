import type { ChatMessage, Tool } from "../types.js";
import { chatOnce, type LlamaClientConfig } from "../client/llama-client.js";
import { toolsToApiFormat } from "./tools.js";

const MAX_STEPS = 5; // safety cap: stops a confused model from looping forever

export async function runAgentTurn(
  history: ChatMessage[],
  availableTools: Tool[],
  config: LlamaClientConfig
): Promise<string> {
  const toolDefs = toolsToApiFormat(availableTools);

  for (let step = 0; step < MAX_STEPS; step++) {
    let assistantMessage: ChatMessage;
    try {
      assistantMessage = await chatOnce(history, config, toolDefs);
    } catch (err) {
      return `Error talking to llama-server: ${(err as Error).message}`;
    }
    history.push(assistantMessage);

    // No tool calls means the model gave a real answer — done.
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return assistantMessage.content;
    }

    // Run every requested tool, feed each result back as a "tool" message.
    for (const call of assistantMessage.tool_calls) {
      const tool = availableTools.find((t) => t.name === call.function.name);
      let result: string;

      if (!tool) {
        result = `Error: unknown tool "${call.function.name}"`;
      } else {
        try {
          // Some llama.cpp builds send arguments as a JSON string (the
          // OpenAI-standard format); others have shipped it as an already-
          // parsed object. Handle both so a server update doesn't break us.
          const raw = call.function.arguments;
          const args = typeof raw === "string" ? JSON.parse(raw) : raw;
          result = await tool.execute(args);
        } catch (err) {
          result = `Error running tool: ${(err as Error).message}`;
        }
      }

      history.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
    }
    // loop again — the model now sees the tool result and responds to it
  }

  return "(Stopped: hit the maximum number of tool-call steps.)";
}