import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chunkMarkdown } from "./chunker.js";
import { embedBatch, type LlamaClientConfig } from "../client/llama-client.js";

export interface IndexedChunk {
  filePath: string;
  heading: string;
  content: string;
  embedding: number[];
}

interface CacheEntry {
  mtimeMs: number;
  chunks: IndexedChunk[];
}

type IndexCache = Record<string, CacheEntry>;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  ".vscode",
  "dist",
  "build",
  ".next",
  ".turbo",
]);

async function findMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Prune ignored and hidden subdirectories immediately to avoid walking
        // massive folders like node_modules or .git.
        if (IGNORED_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".")) {
          continue;
        }
        await walk(path.join(currentDir, entry.name));
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".md") || entry.name.endsWith(".markdown")) {
          files.push(path.join(currentDir, entry.name));
        }
      }
    }
  }

  await walk(dir);
  return files;
}

// Builds (or incrementally updates) the embedding index for a directory of
// markdown files. Unchanged files are skipped by comparing mtime against a
// cache written alongside the docs; new or edited files get re-chunked and
// re-embedded in batches. Files that were deleted since the last run are pruned.
export async function buildIndex(
  docsDir: string,
  embeddingConfig: LlamaClientConfig,
  onProgress: (message: string) => void
): Promise<IndexedChunk[]> {
  const cachePath = path.join(docsDir, ".mithril-index.json");

  let cache: IndexCache = {};
  try {
    const raw = await readFile(cachePath, "utf-8");
    cache = JSON.parse(raw);
  } catch {
    // No cache yet, or it's unreadable/corrupt — starting fresh is fine.
    cache = {};
  }

  const files = await findMarkdownFiles(docsDir);
  const allChunks: IndexedChunk[] = [];
  const newCache: IndexCache = {};
  let cacheDirty = false;

  for (const filePath of files) {
    const stats = await stat(filePath);
    const cached = cache[filePath];

    if (cached && cached.mtimeMs === stats.mtimeMs) {
      newCache[filePath] = cached;
      allChunks.push(...cached.chunks);
      continue;
    }

    cacheDirty = true;
    onProgress(`Embedding ${path.relative(docsDir, filePath)}...`);

    const text = await readFile(filePath, "utf-8");
    const sections = chunkMarkdown(text);
    if (sections.length === 0) {
      newCache[filePath] = { mtimeMs: stats.mtimeMs, chunks: [] };
      continue;
    }

    // Include the section heading in the text passed to the embedding model
    // so topic names are represented in the vector space, while preserving
    // clean content in IndexedChunk for agent context.
    const textsToEmbed = sections.map((s) =>
      s.heading && s.heading !== "Introduction" ? `${s.heading}\n\n${s.content}` : s.content
    );

    const embeddings = await embedBatch(textsToEmbed, embeddingConfig);
    const chunks: IndexedChunk[] = [];

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      chunks.push({
        filePath,
        heading: section.heading,
        content: section.content,
        embedding: embeddings[i]!,
      });
    }

    newCache[filePath] = { mtimeMs: stats.mtimeMs, chunks };
    allChunks.push(...chunks);
  }

  // Check if any deleted files need their cache purged
  const oldCachedKeys = Object.keys(cache);
  if (!cacheDirty && oldCachedKeys.length !== files.length) {
    cacheDirty = true;
  }

  if (cacheDirty) {
    await writeFile(cachePath, JSON.stringify(newCache), "utf-8");
  }

  return allChunks;
}

