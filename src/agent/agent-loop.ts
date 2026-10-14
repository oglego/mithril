import type { ChatMessage, Tool } from "../types.js";
import { chatOnceWithUsage, chatStreamWithUsage, type LlamaClientConfig } from "../client/llama-client.js";
import { toolsToApiFormat } from "./tools.js";
import { isDeclinedResult } from "./tool-results.js";
import { capToolResult, suggestedWindowFor, type CompactionReport, type ContextManager } from "./context-manager.js";

const DEFAULT_MAX_STEPS = 15; // Raised from 5 to allow multi-step coding workflows (search -> read -> edit -> test)

export type StopReason = "answered" | "max_steps" | "context" | "server_error" | "aborted";

// How a single tool call ended, for measurement. "tool_error" is a tool that
// ran but reported failure (its result starts with "Error"); the other
// failure kinds are mistakes by the model (unknown tool, unparseable
// arguments) or a tool that threw.
export type ToolOutcome = "ok" | "unknown_tool" | "bad_arguments" | "tool_exception" | "tool_error" | "declined";

// Optional structured hooks for measuring a run (used by `mithril eval`).
// Observers must not throw; they are purely passive.
export interface AgentObserver {
  onModelCall?: (info: {
    step: number;
    durationMs: number;
    promptTokens?: number | undefined;
    completionTokens?: number | undefined;
  }) => void;
  onToolResult?: (info: { name: string; outcome: ToolOutcome; result: string }) => void;
  // Providing onToken switches model calls to streaming: answer text is
  // reported as it arrives. Tool calls are still only acted on once complete.
  onToken?: (text: string) => void;
  // Reasoning ("thinking") text from models that stream it separately. It is
  // never added to the conversation.
  onReasoning?: (text: string) => void;
  onStop?: (reason: StopReason) => void;
}

function classifyResult(toolName: string, result: string): ToolOutcome {
  if (isDeclinedResult(toolName, result)) return "declined";
  if (/^Error/.test(result)) return "tool_error";
  return "ok";
}

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
  context?: AgentContextOptions,
  observer?: AgentObserver
): Promise<string> {
  const toolDefs = toolsToApiFormat(availableTools);
  const stop = (reason: StopReason, text: string): string => {
    observer?.onStop?.(reason);
    return text;
  };

  for (let step = 0; step < maxSteps; step++) {
    if (config.signal?.aborted) return stop("aborted", "(Stopped: aborted.)");

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
          return stop(
            "context",
            `(Stopped: the system prompt and tool definitions alone use ~${report.fixedTokens} tokens, ` +
              `but the prompt budget is only ${budget}. Restart with --context ${suggestedWindowFor(report.fixedTokens)} or larger.)`
          );
        }
        return stop(
          "context",
          `(Stopped: this request no longer fits in the model's context window ` +
            `(~${report.tokensAfter} tokens needed, budget ${budget}). ` +
            `Restart with a larger --context value, or break the task into smaller steps.)`
        );
      }
    }

    let assistantMessage: ChatMessage;
    const callStarted = Date.now();
    try {
      const { message, usage } = observer?.onToken
        ? await chatStreamWithUsage(history, config, toolDefs, {
            onToken: observer.onToken,
            onReasoning: observer.onReasoning,
          })
        : await chatOnceWithUsage(history, config, toolDefs);
      assistantMessage = message;
      context?.manager.observeUsage(usage.promptTokens);
      observer?.onModelCall?.({
        step,
        durationMs: Date.now() - callStarted,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      });
    } catch (err) {
      if (config.signal?.aborted) return stop("aborted", "(Stopped: aborted.)");
      return stop("server_error", `Error talking to the model server: ${(err as Error).message}`);
    }
    history.push(assistantMessage);

    // No tool calls means the model gave a real answer — done.
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return stop("answered", assistantMessage.content);
    }

    // Run every requested tool, feed each result back as a "tool" message.
    for (const call of assistantMessage.tool_calls) {
      const tool = availableTools.find((t) => t.name === call.function.name);
      let result: string;

      let outcome: ToolOutcome = "ok";

      if (!tool) {
        result = `Error: unknown tool "${call.function.name}"`;
        outcome = "unknown_tool";
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
          observer?.onToolResult?.({ name: call.function.name, outcome: "bad_arguments", result });
          history.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
          continue;
        }

        try {
          result = await tool.execute(args);
          outcome = classifyResult(call.function.name, result);
        } catch (err) {
          result = `Error running tool: ${(err as Error).message}`;
          outcome = "tool_exception";
        }
      }

      observer?.onToolResult?.({ name: call.function.name, outcome, result });

      // A single oversized result must not be able to blow the budget alone.
      if (context) result = capToolResult(result, context.manager.maxToolResultChars);

      history.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
    }
    // loop again — the model now sees the tool result and responds to it
  }

  return stop("max_steps", "(Stopped: hit the maximum number of tool-call steps.)");
}