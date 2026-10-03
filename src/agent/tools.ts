import { readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Tool, ApiToolDefinition } from "../types.js";

function resolveProjectRoot(): string {
  const configuredRoot = process.env.MITHRIL_PROJECT_ROOT;
  if (configuredRoot && configuredRoot.trim().length > 0) {
    return path.resolve(configuredRoot);
  }

  let current = path.resolve(process.cwd());
  while (true) {
    if (existsSync(path.join(current, "package.json")) || existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

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
    const relativePath = args.path;

    // Small local models are more prone than frontier models to producing
    // malformed or incomplete tool-call arguments, despite the schema above
    // saying `path` is required. Validating here turns that into a clear
    // message the model can see and retry from, rather than a confusing
    // crash or downstream failure a few calls later.
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      return 'Error: missing or invalid "path" argument.';
    }

    const projectRoot = resolveProjectRoot();
    const fullPath = path.resolve(projectRoot, relativePath);

    // path.relative tells us how to walk from projectRoot to fullPath.
    // If that walk starts with ".." (goes upward) or is absolute (a
    // different drive on Windows), fullPath is outside projectRoot.
    // This catches cases a plain startsWith() string check misses, e.g.
    // "/project-evil" incorrectly starting with "/project".
    if (!isWithinRoot(projectRoot, fullPath)) {
      return "Error: access outside the project directory is not allowed.";
    }

    try {
      // A symlink inside the project can still point outside it. realpath
      // resolves any symlinks to their true target so we check the path
      // that will actually be read, not just the one that was requested.
      const realFullPath = await realpath(fullPath);
      const realRoot = await realpath(projectRoot);
      if (!isWithinRoot(realRoot, realFullPath)) {
        return "Error: resolved path escapes the project directory.";
      }

      const contents = await readFile(realFullPath, "utf-8");
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