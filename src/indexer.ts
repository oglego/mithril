import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chunkMarkdown } from "./markdown-chunker.js";
import { embedOnce, type LlamaClientConfig } from "./llama-client.js";

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

async function findMarkdownFiles(dir: string): Promise<string[]> {
  // { recursive: true } walks subdirectories too (Node 20.12+).
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      // parentPath gives the entry's actual directory when walking recursively.
      const parent = (entry as { parentPath?: string }).parentPath ?? dir;
      files.push(path.join(parent, entry.name));
    }
  }

  return files;
}

// Builds (or incrementally updates) the embedding index for a directory of
// markdown files. Unchanged files are skipped by comparing mtime against a
// cache written alongside the docs; new or edited files get re-chunked and
// re-embedded, and files that were deleted since the last run are simply
// absent from the result, since we only ever iterate over files found now.
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

  for (const filePath of files) {
    const stats = await stat(filePath);
    const cached = cache[filePath];

    if (cached && cached.mtimeMs === stats.mtimeMs) {
      newCache[filePath] = cached;
      allChunks.push(...cached.chunks);
      continue;
    }

    onProgress(`Embedding ${path.relative(docsDir, filePath)}...`);

    const text = await readFile(filePath, "utf-8");
    const sections = chunkMarkdown(text);
    const chunks: IndexedChunk[] = [];

    for (const section of sections) {
      const embedding = await embedOnce(section.content, embeddingConfig);
      chunks.push({ filePath, heading: section.heading, content: section.content, embedding });
    }

    newCache[filePath] = { mtimeMs: stats.mtimeMs, chunks };
    allChunks.push(...chunks);
  }

  await writeFile(cachePath, JSON.stringify(newCache), "utf-8");

  return allChunks;
}
