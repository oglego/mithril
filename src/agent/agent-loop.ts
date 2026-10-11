import type { ChatMessage, Tool } from "../types.js";
import { chatOnceWithUsage, type LlamaClientConfig } from "../client/llama-client.js";
import { toolsToApiFormat } from "./tools.js";
import { capToolResult, suggestedWindowFor, type CompactionReport, type ContextManager } from "./context-manager.js";

const DEFAULT_MAX_STEPS = 15; // Raised from 5 to allow multi-step coding workflows (search -> read -> edit -> test)

export interface AgentContextOptions {
  manager: ContextManager;
  // Called whenever compaction actually changed the history.
  onCompact?: (report: CompactionReport) => void;
}

export async function runAgentTurn(
  history: ChatMessage[],
  availableTools: Tool[],
  config: LlamaClientConfig,
  onToolCall?: (toolName: string) => void,
  maxSteps: number = DEFAULT_MAX_STEPS,
  context?: AgentContextOptions
): Promise<string> {
  const toolDefs = toolsToApiFormat(availableTools);

  for (let step = 0; step < maxSteps; step++) {
    // Re-check the budget before EVERY model call, not just once per user
    // message: a single turn can run up to maxSteps tool calls, and their
    // results are what actually fill the context window.
    if (context) {
      const report = context.manager.prepare(history, toolDefs);
      if (report.changed) context.onCompact?.(report);
      if (!report.fits) {
        const budget = context.manager.maxInputTokens;
        // Most often the real culprit is a window too small for the agent's
        // fixed overhead, not the conversation. Say so, with a number.
        if (report.fixedTokens > budget * 0.75) {
          return (
            `(Stopped: the system prompt and tool definitions alone use ~${report.fixedTokens} tokens, ` +
            `but the prompt budget is only ${budget}. Restart with --context ${suggestedWindowFor(report.fixedTokens)} or larger.)`
          );
        }
        return (
          `(Stopped: this request no longer fits in the model's context window ` +
          `(~${report.tokensAfter} tokens needed, budget ${budget}). ` +
          `Restart with a larger --context value, or break the task into smaller steps.)`
        );
      }
    }

    let assistantMessage: ChatMessage;
    try {
      const { message, usage } = await chatOnceWithUsage(history, config, toolDefs);
      assistantMessage = message;
      context?.manager.observeUsage(usage.promptTokens);
    } catch (err) {
      return `Error talking to the model server: ${(err as Error).message}`;
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

      // A single oversized result must not be able to blow the budget alone.
      if (context) result = capToolResult(result, context.manager.maxToolResultChars);

      history.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
    }
    // loop again — the model now sees the tool result and responds to it
  }

  return "(Stopped: hit the maximum number of tool-call steps.)";
}