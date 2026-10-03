import path from "node:path";
import type { Tool } from "../types.js";
import type { IndexedChunk } from "./indexer.js";
import { retrieveTopK } from "./retriever.js";
import { embedOnce, type LlamaClientConfig } from "../client/llama-client.js";

// A factory rather than a static export like tools.ts's readFileTool,
// because search_docs needs to close over the index and embedding config —
// both of which only exist once --docs has been provided and indexing has run.
export function createSearchDocsTool(
  index: IndexedChunk[],
  docsDir: string,
  embeddingConfig: LlamaClientConfig
): Tool {
  return {
    name: "search_docs",
    description:
      "Search the user's local markdown notes for relevant passages. Use this when the user asks something that might be answered by their notes.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const query = args.query;

      if (typeof query !== "string" || query.length === 0) {
        return 'Error: missing or invalid "query" argument.';
      }

      if (index.length === 0) {
        return "No indexed documents are available.";
      }

      const prompt = embeddingConfig.queryPrefix
        ? `${embeddingConfig.queryPrefix}${query}`
        : query;

      const queryEmbedding = await embedOnce(prompt, embeddingConfig);
      const results = retrieveTopK(queryEmbedding, index, 4);

      if (results.length === 0) {
        return `No relevant passages found for "${query}".`;
      }

      return results
        .map((r) => `# ${path.relative(docsDir, r.filePath)} — ${r.heading}\n${r.content}`)
        .join("\n\n---\n\n");
    },
  };
}

