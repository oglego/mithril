import type { Tool } from "../types.js";

// Builds a system prompt that tells the model who it is and what tools are
// available. Generated dynamically rather than hardcoded, so the prompt
// automatically stays accurate when tools are added or removed (e.g. when
// --docs enables the search_docs tool).
export function buildSystemPrompt(tools: Tool[]): string {
  const toolBlock = tools
    .map((t) => `- **${t.name}**: ${t.description}`)
    .join("\n");

  return [
    "You are Mithril, a helpful local AI assistant running entirely on the user's machine.",
    "You are direct, concise, and friendly. You answer questions clearly and use the tools available to you when they would help answer the user's question.",
    "",
    "## Available Tools",
    "",
    toolBlock,
    "",
    "Only call a tool when it would genuinely help answer the question. If the user's question can be answered from your own knowledge, answer directly without calling any tools.",
    "When you use a tool, explain what you found based on the result.",
  ].join("\n");
}
