import type { ChatMessage, Tool } from "../types.js";
import { chatOnce, type LlamaClientConfig } from "../client/llama-client.js";
import { toolsToApiFormat } from "./tools.js";

const DEFAULT_MAX_STEPS = 15; // Raised from 5 to allow multi-step coding workflows (search -> read -> edit -> test)

export async function runAgentTurn(
  history: ChatMessage[],
  availableTools: Tool[],
  config: LlamaClientConfig,
  onToolCall?: (toolName: string) => void,
  maxSteps: number = DEFAULT_MAX_STEPS
): Promise<string> {
  const toolDefs = toolsToApiFormat(availableTools);

  for (let step = 0; step < maxSteps; step++) {
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
        onToolCall?.(tool.name);

        let args: Record<string, unknown>;
        try {
          // Some llama.cpp builds send arguments as a JSON string (the
          // OpenAI-standard format); others have shipped it as an already-
          // parsed object. Handle both so a server update doesn't break us.
          const raw = call.function.arguments;
          args = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
        } catch (parseErr) {
          result = `Error: invalid JSON in tool arguments: ${(parseErr as Error).message}. Please retry with valid JSON.`;
          history.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
          continue;
        }

        try {
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