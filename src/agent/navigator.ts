import { readdir, stat, readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "models",
  "dist",
  "build",
  ".next",
  ".cache",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".llamafile",
  ".bin",
  ".exe",
  ".part",
  ".dylib",
  ".so",
  ".sqlite",
]);

function isIgnored(dirName: string): boolean {
  return DEFAULT_IGNORED_DIRS.has(dirName) || dirName.startsWith(".git");
}

function isBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function listDirectory(dirPath: string, projectRoot: string): Promise<string> {
  const entries = await readdir(dirPath, { withFileTypes: true });

  const dirs: string[] = [];
  const files: { name: string; size: number }[] = [];

  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;

    if (entry.isDirectory()) {
      dirs.push(entry.name);
    } else if (entry.isFile()) {
      try {
        const fileStat = await stat(path.join(dirPath, entry.name));
        files.push({ name: entry.name, size: fileStat.size });
      } catch {
        files.push({ name: entry.name, size: 0 });
      }
    }
  }

  dirs.sort();
  files.sort((a, b) => a.name.localeCompare(b.name));

  const rel = path.relative(projectRoot, dirPath) || ".";
  const output: string[] = [`Directory listing for: ${rel}\n`];

  for (const d of dirs) {
    output.push(`[DIR]  ${d}/`);
  }
  for (const f of files) {
    output.push(`[FILE] ${f.name} (${f.size} bytes)`);
  }

  if (dirs.length === 0 && files.length === 0) {
    output.push("(Empty directory)");
  }

  return output.join("\n");
}

export interface FindFilesOptions {
  pattern?: string | undefined;
  extension?: string | undefined;
  maxResults?: number | undefined;
}

export async function findFiles(
  startDir: string,
  projectRoot: string,
  options: FindFilesOptions = {}
): Promise<string> {
  const { pattern, extension, maxResults = 50 } = options;
  const matches: string[] = [];

  let extClean = extension?.trim();
  if (extClean && !extClean.startsWith(".")) {
    extClean = `.${extClean}`;
  }

  let patternRegex: RegExp | null = null;
  if (pattern && pattern.trim().length > 0) {
    // Convert basic glob wildcard '*' to regex '.*'
    const escaped = pattern
      .trim()
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    patternRegex = new RegExp(escaped, "i");
  }

  async function walk(currentDir: string): Promise<void> {
    if (matches.length >= maxResults) return;

    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= maxResults) return;

      if (entry.isDirectory()) {
        if (!isIgnored(entry.name)) {
          await walk(path.join(currentDir, entry.name));
        }
      } else if (entry.isFile()) {
        if (entry.name === ".DS_Store") continue;

        if (extClean && !entry.name.endsWith(extClean)) {
          continue;
        }

        if (patternRegex && !patternRegex.test(entry.name)) {
          continue;
        }

        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(projectRoot, fullPath);
        matches.push(relPath);
      }
    }
  }

  await walk(startDir);

  if (matches.length === 0) {
    return "No matching files found.";
  }

  let result = matches.join("\n");
  if (matches.length >= maxResults) {
    result += `\n\n[Reached maximum limit of ${maxResults} matches. Refine your query or specify a subdirectory to narrow results.]`;
  }

  return result;
}

export interface SearchCodeOptions {
  query: string;
  isRegex?: boolean | undefined;
  maxResults?: number | undefined;
}

export async function searchCode(
  startDir: string,
  projectRoot: string,
  options: SearchCodeOptions
): Promise<string> {
  const { query, isRegex = false, maxResults = 50 } = options;

  if (!query || query.length === 0) {
    return 'Error: missing or empty "query" argument.';
  }

  let matcher: RegExp;
  try {
    matcher = isRegex ? new RegExp(query, "i") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  } catch (err) {
    return `Error: invalid regular expression "${query}": ${(err as Error).message}`;
  }

  const results: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    if (results.length >= maxResults) return;

    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) return;

      if (entry.isDirectory()) {
        if (!isIgnored(entry.name)) {
          await walk(path.join(currentDir, entry.name));
        }
      } else if (entry.isFile()) {
        const fullPath = path.join(currentDir, entry.name);
        if (isBinary(fullPath) || entry.name === ".DS_Store") continue;

        try {
          const content = await readFile(fullPath, "utf-8");
          const lines = content.split(/\r?\n/);
          const relPath = path.relative(projectRoot, fullPath);

          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            if (results.length >= maxResults) return;

            const line = lines[lineIdx]!;
            if (matcher.test(line)) {
              results.push(`${relPath}:${lineIdx + 1}: ${line.trim()}`);
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(startDir);

  if (results.length === 0) {
    return `No matches found for "${query}".`;
  }

  let output = results.join("\n");
  if (results.length >= maxResults) {
    output += `\n\n[Reached maximum limit of ${maxResults} matches. Refine your query or specify a subdirectory to narrow results.]`;
  }

  return output;
}
