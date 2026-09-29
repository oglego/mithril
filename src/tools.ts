import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Tool, ApiToolDefinition } from "./types.js";

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a text file from disk, given a relative path.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to the file to read." },
    },
    required: ["path"],
  },
  execute: async (args) => {
    const relativePath = args.path as string;

    // Basic safety rail: resolve the path and refuse anything that
    // escapes the project directory (e.g. "../../../etc/passwd").
    const fullPath = path.resolve(process.cwd(), relativePath);
    if (!fullPath.startsWith(process.cwd())) {
      return "Error: access outside the project directory is not allowed.";
    }

    try {
      const contents = await readFile(fullPath, "utf-8");
      return contents.slice(0, 4000); // cap size so we don't blow the model's context
    } catch (err) {
      return `Error reading file: ${(err as Error).message}`;
    }
  },
};

export const tools: Tool[] = [readFileTool];

// Our internal Tool shape includes an `execute` function, which isn't
// something we can send over HTTP — this strips it down to just what
// the API needs to know about.
export function toolsToApiFormat(toolList: Tool[]): ApiToolDefinition[] {
  return toolList.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}