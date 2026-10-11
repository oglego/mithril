import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { FALLBACK_CATALOG, CATALOG_REPO, type ModelInfo } from "./catalog.js";

// Where the model list came from, so the UI can tell the user whether they're
// looking at fresh data or a stale/offline list.
export type CatalogOrigin = "live" | "cache" | "stale-cache" | "fallback";

export interface LoadedCatalog {
  models: ModelInfo[];
  origin: CatalogOrigin;
}

export interface LoadCatalogOptions {
  cachePath?: string | undefined; // omit to disable caching
  ttlMs?: number;
  timeoutMs?: number;
  repo?: string;
  fallback?: ModelInfo[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

export function treeUrl(repo: string = CATALOG_REPO): string {
  return `https://huggingface.co/api/models/${repo}/tree/main`;
}

export function downloadUrl(repo: string, filename: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(filename)}`;
}

// 3_400_000_000 -> "3.4 GB". Decimal units, one decimal place below 10.
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const text = value >= 10 || unit === 0 ? Math.round(value).toString() : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

// Quantization suffixes seen in GGUF/llamafile names: Q8_0, Q5_K_S, Q4_K_M,
// IQ3_XS, F16, BF16, MXFP4, ...
const QUANT_SUFFIX = /^(?:I?Q\d(?:_[A-Z0-9]+)*|F16|F32|BF16|MXFP4)$/i;

// Best-effort readable name for a model we have no curated entry for:
//   "Qwen3.5-4B-Q5_K_S.llamafile" -> "Qwen3.5 4B (Q5_K_S)"
export function deriveName(filename: string): string {
  const parts = filename.replace(/\.llamafile$/i, "").split("-").filter(Boolean);
  const last = parts[parts.length - 1];
  let quant: string | undefined;
  if (parts.length > 1 && last && QUANT_SUFFIX.test(last)) {
    quant = last;
    parts.pop();
  }
  return parts.join(" ") + (quant ? ` (${quant})` : "");
}

// Only chat-capable llamafiles belong in the picker. Embedding models are
// handled separately (RAG) and multimodal projector files aren't runnable.
function isChatModelFile(filename: string): boolean {
  return /\.llamafile$/i.test(filename) && !/embed|mmproj/i.test(filename);
}

// Turns the Hugging Face "tree" API response into catalog entries. Written
// defensively: anything unexpected is skipped rather than thrown on, and the
// caller treats an empty result as "fall back".
//
// Expected shape (an array): [{ type: "file", path: "X.llamafile", size: 123,
// lfs?: { size: 123 } }, ...]. LFS files report their real size in lfs.size.
export function parseTree(json: unknown, repo: string, curated: ModelInfo[] = FALLBACK_CATALOG): ModelInfo[] {
  if (!Array.isArray(json)) return [];
  const curatedByFile = new Map(curated.map((m) => [m.filename, m]));
  const found: { info: ModelInfo; bytes: number }[] = [];

  for (const entry of json) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { type?: unknown; path?: unknown; size?: unknown; lfs?: { size?: unknown } };
    if (e.type !== "file" || typeof e.path !== "string" || e.path.includes("/")) continue;
    if (!isChatModelFile(e.path)) continue;

    const bytes = typeof e.lfs?.size === "number" ? e.lfs.size : typeof e.size === "number" ? e.size : 0;
    const known = curatedByFile.get(e.path);
    const info: ModelInfo = {
      name: known?.name ?? deriveName(e.path),
      size: bytes > 0 ? formatSize(bytes) : (known?.size ?? "unknown size"),
      url: downloadUrl(repo, e.path),
      filename: e.path,
      ...(known?.license ? { license: known.license } : {}),
    };
    found.push({ info, bytes });
  }

  return found.sort((a, b) => a.bytes - b.bytes || a.info.name.localeCompare(b.info.name)).map((f) => f.info);
}

interface CacheFile {
  fetchedAt: number;
  repo: string;
  models: ModelInfo[];
}

function isValidModelInfo(m: unknown): m is ModelInfo {
  if (!m || typeof m !== "object") return false;
  const x = m as Record<string, unknown>;
  return ["name", "size", "url", "filename"].every((k) => typeof x[k] === "string" && (x[k] as string).length > 0);
}

async function readCache(cachePath: string, repo: string): Promise<CacheFile | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(cachePath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    const c = parsed as Partial<CacheFile>;
    if (c.repo !== repo || typeof c.fetchedAt !== "number" || !Array.isArray(c.models)) return null;
    if (c.models.length === 0 || !c.models.every(isValidModelInfo)) return null;
    return c as CacheFile;
  } catch {
    return null; // missing or corrupt cache is never fatal
  }
}

async function writeCache(cachePath: string, cache: CacheFile): Promise<void> {
  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // Caching is an optimisation; failing to write it must not break startup.
  }
}

// Resolution order:
//   1. fresh cache (younger than ttl)              -> "cache"
//   2. live listing from the model repo            -> "live"   (and cached)
//   3. stale cache, if the live fetch failed       -> "stale-cache"
//   4. the curated list bundled with Mithril       -> "fallback"
// This function never throws: the picker must always have something to show.
export async function loadCatalog(options: LoadCatalogOptions = {}): Promise<LoadedCatalog> {
  const {
    cachePath,
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    repo = CATALOG_REPO,
    fallback = FALLBACK_CATALOG,
    fetchImpl = fetch,
    now = Date.now,
  } = options;

  const cached = cachePath ? await readCache(cachePath, repo) : null;
  if (cached && now() - cached.fetchedAt < ttlMs) {
    return { models: cached.models, origin: "cache" };
  }

  try {
    const response = await fetchImpl(treeUrl(repo), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const models = parseTree(await response.json(), repo, fallback);
    if (models.length === 0) throw new Error("no models found in listing");
    if (cachePath) await writeCache(cachePath, { fetchedAt: now(), repo, models });
    return { models, origin: "live" };
  } catch {
    if (cached) return { models: cached.models, origin: "stale-cache" };
    return { models: fallback, origin: "fallback" };
  }
}

// Adds any .llamafile already sitting in the models directory that the
// catalog doesn't list (e.g. upstream removed it, or the user dropped one in
// by hand), so already-downloaded models never disappear from the picker.
export async function mergeInstalledModels(catalog: ModelInfo[], modelsDir: string): Promise<ModelInfo[]> {
  let names: string[];
  try {
    names = await readdir(modelsDir);
  } catch {
    return catalog;
  }
  const known = new Set(catalog.map((m) => m.filename));
  const extras: ModelInfo[] = [];
  for (const name of names) {
    if (known.has(name) || !isChatModelFile(name)) continue;
    try {
      const { size } = await stat(path.join(modelsDir, name));
      extras.push({ name: deriveName(name), size: formatSize(size), url: "", filename: name });
    } catch {
      // unreadable entry — skip it
    }
  }
  return [...catalog, ...extras.sort((a, b) => a.name.localeCompare(b.name))];
}
