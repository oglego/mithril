import { readFile, writeFile, rename, mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Tool, ApiToolDefinition } from "../types.js";
import { formatUnifiedDiff } from "./diff.js";
import { applyReplacement, backupRegistry } from "./file-editor.js";
import { listDirectory, findFiles, searchCode } from "./navigator.js";
import { executeCommand } from "./executor.js";

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

// Walks upward from a path until it finds a directory that actually exists
// on disk. Used to realpath-check a location before creating a new file
// there: you can't realpath() something that doesn't exist yet, but you can
// realpath its nearest existing ancestor to catch a symlinked intermediate
// directory that would silently redirect the write outside the project.
async function nearestExistingAncestor(target: string): Promise<string> {
  let current = target;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current; // reached filesystem root
    current = parent;
  }
  return current;
}

function isProtectedPath(root: string, target: string): { protected: boolean; reason?: string } {
  const relative = path.relative(root, target).replace(/\\/g, "/");
  const parts = relative.split("/");

  // Protect git repository metadata
  if (parts.includes(".git") || relative === ".git") {
    return { protected: true, reason: "Git metadata (.git) is protected from modification." };
  }

  // Protect environment variables and secrets
  const baseName = path.basename(target);
  if (baseName === ".env" || baseName.startsWith(".env.")) {
    return { protected: true, reason: "Environment files (.env) are protected from modification." };
  }

  // Protect the repo-root llamafile models directory specifically — not any
  // path segment literally named "models" at any depth. An unanchored check
  // here would also block src/models/ (legitimate source code, unrelated to
  // the downloaded-binaries folder this is meant to protect) — the same bug
  // class that previously broke this project's .gitignore.
  if (relative === "models" || relative.startsWith("models/")) {
    return { protected: true, reason: "Models directory (models/) is protected from modification." };
  }

  return { protected: false };
}

export interface DiffConfirmDetails {
  filePath: string;
  relativePath: string;
  oldContent: string;
  newContent: string;
  diff: string;
}

export type DiffConfirmCallback = (details: DiffConfirmDetails) => Promise<boolean>;
export type CommandConfirmCallback = (command: string) => Promise<boolean>;

export interface ToolOptions {
  confirm?: DiffConfirmCallback;
  confirmCommand?: CommandConfirmCallback;
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a text file. Use start_line and line_count to read part of a large file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      start_line: { type: "integer", description: "1-indexed." },
      line_count: { type: "integer" },
      line_numbers: { type: "boolean", description: "Prefix each line with its number." },
    },
    required: ["path"],
  },
  execute: async (args) => {
    const relativePath = args.path;

    if (typeof relativePath !== "string" || relativePath.length === 0) {
      return 'Error: missing or invalid "path" argument.';
    }

    if (args.start_line !== undefined && (!Number.isInteger(args.start_line) || (args.start_line as number) < 1)) {
      return 'Error: "start_line" must be a positive integer (>= 1).';
    }

    if (args.line_count !== undefined && (!Number.isInteger(args.line_count) || (args.line_count as number) < 1)) {
      return 'Error: "line_count" must be a positive integer (>= 1).';
    }

    const projectRoot = resolveProjectRoot();
    const fullPath = path.resolve(projectRoot, relativePath);

    if (!isWithinRoot(projectRoot, fullPath)) {
      return "Error: access outside the project directory is not allowed.";
    }

    try {
      const realFullPath = await realpath(fullPath);
      const realRoot = await realpath(projectRoot);
      if (!isWithinRoot(realRoot, realFullPath)) {
        return "Error: resolved path escapes the project directory.";
      }

      const contents = await readFile(realFullPath, "utf-8");
      if (contents.length === 0) {
        return "";
      }

      const allLines = contents.split(/\r?\n/);
      const totalLines = allLines.length;
      const lineNumbers = Boolean(args.line_numbers);
      const isSliceRequested = args.start_line !== undefined || args.line_count !== undefined;

      if (isSliceRequested) {
        const startLine = (args.start_line as number | undefined) ?? 1;
        if (startLine > totalLines) {
          return `Error: start_line ${startLine} is beyond the end of the file (${totalLines} total lines).`;
        }

        const startIndex = startLine - 1;
        const count = (args.line_count as number | undefined) ?? (totalLines - startIndex);
        const endIndex = Math.min(startIndex + count, totalLines);
        const selected = allLines.slice(startIndex, endIndex);

        let output = lineNumbers
          ? selected.map((line, idx) => `${startIndex + idx + 1}: ${line}`).join("\n")
          : selected.join("\n");

        if (endIndex < totalLines) {
          output += `\n\n[Showing lines ${startLine}-${endIndex} of ${totalLines}. Use start_line=${endIndex + 1} to read further.]`;
        }

        return output;
      }

      const MAX_UNPAGINATED_CHARS = 8000;
      const MAX_UNPAGINATED_LINES = 150;

      if (contents.length <= MAX_UNPAGINATED_CHARS && totalLines <= MAX_UNPAGINATED_LINES) {
        return lineNumbers
          ? allLines.map((line, idx) => `${idx + 1}: ${line}`).join("\n")
          : contents;
      }

      const DEFAULT_PAGE_LINES = 100;
      const selected = allLines.slice(0, DEFAULT_PAGE_LINES);
      let output = lineNumbers
        ? selected.map((line, idx) => `${idx + 1}: ${line}`).join("\n")
        : selected.join("\n");

      output += `\n\n[File truncated: showing lines 1-${DEFAULT_PAGE_LINES} of ${totalLines}. Use start_line=${DEFAULT_PAGE_LINES + 1} to read further.]`;
      return output;
    } catch (err) {
      return `Error reading file: ${(err as Error).message}`;
    }
  },
};

export function createWriteFileTool(options?: ToolOptions): Tool {
  return {
    name: "write_file",
    description:
      "Create a file, or fully replace one (set overwrite=true). Prefer edit_file for changes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "The complete file content." },
        overwrite: { type: "boolean", description: "Required to replace an existing file." },
      },
      required: ["path", "content"],
    },
    execute: async (args) => {
      const relativePath = args.path;
      const content = args.content;
      const overwrite = Boolean(args.overwrite);

      if (typeof relativePath !== "string" || relativePath.length === 0) {
        return 'Error: missing or invalid "path" argument.';
      }
      if (typeof content !== "string") {
        return 'Error: missing or invalid "content" argument.';
      }

      const projectRoot = resolveProjectRoot();
      const fullPath = path.resolve(projectRoot, relativePath);

      if (!isWithinRoot(projectRoot, fullPath)) {
        return "Error: access outside the project directory is not allowed.";
      }

      const protection = isProtectedPath(projectRoot, fullPath);
      if (protection.protected) {
        return `Error: ${protection.reason}`;
      }

      // Catches a symlinked intermediate directory even for a file that
      // doesn't exist yet (fullPath itself can't be realpath'd in that
      // case) — e.g. "legit-looking-dir/new.txt" where legit-looking-dir
      // is a symlink pointing outside the project. The textual
      // isWithinRoot check above wouldn't catch this on its own.
      try {
        const ancestor = await nearestExistingAncestor(path.dirname(fullPath));
        const realAncestor = await realpath(ancestor);
        const realRoot = await realpath(projectRoot);
        if (!isWithinRoot(realRoot, realAncestor)) {
          return "Error: resolved path escapes the project directory.";
        }
      } catch (err) {
        return `Error resolving path: ${(err as Error).message}`;
      }

      const fileExists = existsSync(fullPath);
      let oldContent = "";

      if (fileExists) {
        if (!overwrite) {
          return `Error: File "${relativePath}" already exists. Use edit_file to modify existing files, or pass overwrite=true to replace the entire file.`;
        }

        try {
          const realFullPath = await realpath(fullPath);
          oldContent = await readFile(realFullPath, "utf-8");
        } catch (err) {
          return `Error reading existing file for overwrite: ${(err as Error).message}`;
        }
      }

      const diff = formatUnifiedDiff(relativePath, oldContent, content, { colorize: true });

      if (options?.confirm) {
        const approved = await options.confirm({
          filePath: fullPath,
          relativePath,
          oldContent,
          newContent: content,
          diff,
        });

        if (!approved) {
          return "File write was declined by the user.";
        }
      }

      try {
        if (fileExists && oldContent.length > 0) {
          backupRegistry.record(fullPath, relativePath, oldContent);
        }

        await mkdir(path.dirname(fullPath), { recursive: true });
        const tempPath = `${fullPath}.tmp.${Date.now()}`;
        await writeFile(tempPath, content, "utf-8");
        await rename(tempPath, fullPath);

        return `Successfully wrote file "${relativePath}".`;
      } catch (err) {
        return `Error writing file: ${(err as Error).message}`;
      }
    },
  };
}

export function createEditFileTool(options?: ToolOptions): Tool {
  return {
    name: "edit_file",
    description:
      "Replace target_content with replacement_content in an existing file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        target_content: { type: "string", description: "Exact text to find; must match exactly once." },
        replacement_content: { type: "string" },
        allow_multiple: { type: "boolean", description: "Replace every match instead of requiring one." },
      },
      required: ["path", "target_content", "replacement_content"],
    },
    execute: async (args) => {
      const relativePath = args.path;
      const targetContent = args.target_content;
      const replacementContent = args.replacement_content;
      const allowMultiple = Boolean(args.allow_multiple);

      if (typeof relativePath !== "string" || relativePath.length === 0) {
        return 'Error: missing or invalid "path" argument.';
      }
      if (typeof targetContent !== "string" || targetContent.length === 0) {
        return 'Error: missing or invalid "target_content" argument.';
      }
      if (typeof replacementContent !== "string") {
        return 'Error: missing or invalid "replacement_content" argument.';
      }

      const projectRoot = resolveProjectRoot();
      const fullPath = path.resolve(projectRoot, relativePath);

      if (!isWithinRoot(projectRoot, fullPath)) {
        return "Error: access outside the project directory is not allowed.";
      }

      const protection = isProtectedPath(projectRoot, fullPath);
      if (protection.protected) {
        return `Error: ${protection.reason}`;
      }

      if (!existsSync(fullPath)) {
        return `Error: File "${relativePath}" does not exist. Use write_file to create new files.`;
      }

      try {
        const realFullPath = await realpath(fullPath);
        const realRoot = await realpath(projectRoot);
        if (!isWithinRoot(realRoot, realFullPath)) {
          return "Error: resolved path escapes the project directory.";
        }

        const currentContent = await readFile(realFullPath, "utf-8");
        const editResult = applyReplacement(
          currentContent,
          targetContent,
          replacementContent,
          allowMultiple
        );

        if (!editResult.success || editResult.content === undefined) {
          return `Error editing file: ${editResult.error}`;
        }

        const diff = formatUnifiedDiff(relativePath, currentContent, editResult.content, {
          colorize: true,
        });

        if (options?.confirm) {
          const approved = await options.confirm({
            filePath: realFullPath,
            relativePath,
            oldContent: currentContent,
            newContent: editResult.content,
            diff,
          });

          if (!approved) {
            return "File edit was declined by the user.";
          }
        }

        backupRegistry.record(realFullPath, relativePath, currentContent);

        const tempPath = `${realFullPath}.tmp.${Date.now()}`;
        await writeFile(tempPath, editResult.content, "utf-8");
        await rename(tempPath, realFullPath);

        const matchInfo =
          editResult.matchType === "whitespace_normalized"
            ? " (applied via whitespace-tolerant match)"
            : "";
        return `Successfully updated "${relativePath}"${matchInfo}.`;
      } catch (err) {
        return `Error editing file: ${(err as Error).message}`;
      }
    },
  };
}

export const listDirTool: Tool = {
  name: "list_dir",
  description:
    "List a directory (default: project root) with file sizes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
  },
  execute: async (args) => {
    const rawPath = typeof args.path === "string" && args.path.trim().length > 0 ? args.path : ".";
    const projectRoot = resolveProjectRoot();
    const fullPath = path.resolve(projectRoot, rawPath);

    if (!isWithinRoot(projectRoot, fullPath)) {
      return "Error: access outside the project directory is not allowed.";
    }

    try {
      const realFullPath = await realpath(fullPath);
      const realRoot = await realpath(projectRoot);
      if (!isWithinRoot(realRoot, realFullPath)) {
        return "Error: resolved path escapes the project directory.";
      }
      return await listDirectory(realFullPath, projectRoot);
    } catch (err) {
      return `Error listing directory: ${(err as Error).message}`;
    }
  },
};

export const findFilesTool: Tool = {
  name: "find_files",
  description:
    "Recursively find files by name pattern and/or extension. Skips node_modules, .git and models.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Wildcard, e.g. '*test*'." },
      extension: { type: "string", description: "e.g. 'ts'." },
      directory: { type: "string" },
    },
  },
  execute: async (args) => {
    const rawDir = typeof args.directory === "string" && args.directory.trim().length > 0 ? args.directory : ".";
    const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
    const extension = typeof args.extension === "string" ? args.extension : undefined;

    const projectRoot = resolveProjectRoot();
    const fullPath = path.resolve(projectRoot, rawDir);

    if (!isWithinRoot(projectRoot, fullPath)) {
      return "Error: access outside the project directory is not allowed.";
    }

    try {
      const realFullPath = await realpath(fullPath);
      const realRoot = await realpath(projectRoot);
      if (!isWithinRoot(realRoot, realFullPath)) {
        return "Error: resolved path escapes the project directory.";
      }
      return await findFiles(realFullPath, projectRoot, { pattern, extension });
    } catch (err) {
      return `Error finding files: ${(err as Error).message}`;
    }
  },
};

export const searchCodeTool: Tool = {
  name: "search_code",
  description:
    "Search file contents for text or a regex. Returns path, line number and snippet.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      is_regex: { type: "boolean", description: "Treat query as a regex." },
      directory: { type: "string" },
    },
    required: ["query"],
  },
  execute: async (args) => {
    const query = args.query;
    if (typeof query !== "string" || query.length === 0) {
      return 'Error: missing or invalid "query" argument.';
    }

    const rawDir = typeof args.directory === "string" && args.directory.trim().length > 0 ? args.directory : ".";
    const isRegex = Boolean(args.is_regex);

    const projectRoot = resolveProjectRoot();
    const fullPath = path.resolve(projectRoot, rawDir);

    if (!isWithinRoot(projectRoot, fullPath)) {
      return "Error: access outside the project directory is not allowed.";
    }

    try {
      const realFullPath = await realpath(fullPath);
      const realRoot = await realpath(projectRoot);
      if (!isWithinRoot(realRoot, realFullPath)) {
        return "Error: resolved path escapes the project directory.";
      }
      return await searchCode(realFullPath, projectRoot, { query, isRegex });
    } catch (err) {
      return `Error searching code: ${(err as Error).message}`;
    }
  },
};

export function createRunCommandTool(options?: ToolOptions): Tool {
  return {
    name: "run_command",
    description:
      "Run a shell command in the project root (tests, builds, linters). Time and output are limited.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_seconds: { type: "integer", description: "Default 30, max 120." },
      },
      required: ["command"],
    },
    execute: async (args) => {
      const command = args.command;
      if (typeof command !== "string" || command.trim().length === 0) {
        return 'Error: missing or invalid "command" argument.';
      }

      const timeoutSeconds =
        typeof args.timeout_seconds === "number" && Number.isInteger(args.timeout_seconds)
          ? args.timeout_seconds
          : undefined;

      if (options?.confirmCommand) {
        const approved = await options.confirmCommand(command.trim());
        if (!approved) {
          return "Command execution was declined by the user.";
        }
      }

      const projectRoot = resolveProjectRoot();
      const result = await executeCommand(command.trim(), projectRoot, { timeoutSeconds });

      return `[Exit code: ${result.exitCode} (${result.durationMs}ms)]\n\n${result.output}`;
    },
  };
}

// These capability-dangerous tools are intentionally created only through
// the factory functions above, which require a caller-supplied confirmation
// callback before they can mutate files or execute shell commands. The
// default `tools` array below stays read-only by construction; callers that
// want write/edit/command capabilities must create guarded tool instances
// explicitly.
export const tools: Tool[] = [readFileTool, listDirTool, findFilesTool, searchCodeTool];

// Our internal Tool shape includes an `execute` function, which isn't
// something we can send over HTTP — this strips it down to just what
// the API needs to know about.
// write_file, edit_file and run_command are deliberately NOT in the default
// `tools` array: they can change the machine, so they must always be built
// with a confirmation callback. Every caller (the chat REPL, the eval
// harness) adds them through this one function so the set stays identical.
export function withMutatingTools(
  base: Tool[],
  callbacks: { confirm: DiffConfirmCallback; confirmCommand: CommandConfirmCallback }
): Tool[] {
  return [
    ...base,
    createWriteFileTool({ confirm: callbacks.confirm }),
    createEditFileTool({ confirm: callbacks.confirm }),
    createRunCommandTool({ confirmCommand: callbacks.confirmCommand }),
  ];
}

export function toolsToApiFormat(toolList: Tool[]): ApiToolDefinition[] {
  return toolList.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}