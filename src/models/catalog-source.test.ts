import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatSize, deriveName, parseTree, loadCatalog, mergeInstalledModels, treeUrl, downloadUrl } from "./catalog-source.js";
import { FALLBACK_CATALOG, type ModelInfo } from "./catalog.js";

const REPO = "owner/repo";
const tree = [
  { type: "file", path: "README.md", size: 10 },
  { type: "directory", path: "sub" },
  { type: "file", path: "Qwen3.5-4B-Q5_K_S.llamafile", size: 134, lfs: { size: 4_100_000_000 } },
  { type: "file", path: "Brand-New-Model-7B-Q4_K_M.llamafile", size: 134, lfs: { size: 5_000_000_000 } },
  { type: "file", path: "mxbai-embed-large-v1-f16.llamafile", lfs: { size: 699_000_000 } },
  { type: "file", path: "sub/Nested.llamafile", size: 5 },
  { type: "file", path: "Qwen3.5-0.8B-Q8_0.llamafile", size: 1_600_000_000 },
];

test("formatSize uses decimal units", () => {
  assert.equal(formatSize(1_600_000_000), "1.6 GB");
  assert.equal(formatSize(12_000_000_000), "12 GB");
  assert.equal(formatSize(699_000_000), "699 MB");
  assert.equal(formatSize(512), "512 B");
});

test("deriveName splits off quantization suffixes", () => {
  assert.equal(deriveName("Qwen3.5-4B-Q5_K_S.llamafile"), "Qwen3.5 4B (Q5_K_S)");
  assert.equal(deriveName("Qwen3.5-0.8B-Q8_0.llamafile"), "Qwen3.5 0.8B (Q8_0)");
  assert.equal(deriveName("gpt-oss-20b-mxfp4.llamafile"), "gpt oss 20b (mxfp4)");
  assert.equal(deriveName("Apertus-8B-Instruct-2509.llamafile"), "Apertus 8B Instruct 2509");
});

test("parseTree keeps chat llamafiles only, sorted by size, with real LFS sizes", () => {
  const models = parseTree(tree, REPO);
  assert.deepEqual(models.map((m) => m.filename), [
    "Qwen3.5-0.8B-Q8_0.llamafile",
    "Qwen3.5-4B-Q5_K_S.llamafile",
    "Brand-New-Model-7B-Q4_K_M.llamafile",
  ]);
  assert.equal(models[1]!.size, "4.1 GB"); // from lfs.size, not the 134-byte pointer
});

test("parseTree uses curated names/licenses where known and derives the rest", () => {
  const models = parseTree(tree, REPO);
  const curated = models.find((m) => m.filename === "Qwen3.5-4B-Q5_K_S.llamafile")!;
  const novel = models.find((m) => m.filename.startsWith("Brand-New"))!;
  assert.equal(curated.name, "Qwen3.5 4B (Q5_K_S)");
  assert.equal(curated.license, "Apache 2.0");
  assert.equal(novel.name, "Brand New Model 7B (Q4_K_M)");
  assert.equal(novel.license, undefined);
  assert.equal(novel.url, downloadUrl(REPO, "Brand-New-Model-7B-Q4_K_M.llamafile"));
});

test("parseTree tolerates garbage", () => {
  assert.deepEqual(parseTree(null, REPO), []);
  assert.deepEqual(parseTree({ error: "nope" }, REPO), []);
  assert.deepEqual(parseTree([null, 5, "x", { type: "file" }], REPO), []);
});

function fakeFetch(handler: () => Response | Promise<Response>, counter = { n: 0 }): typeof fetch {
  return (async () => {
    counter.n++;
    return handler();
  }) as unknown as typeof fetch;
}
const ok = () => new Response(JSON.stringify(tree), { status: 200 });

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "mithril-cat-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadCatalog fetches live, writes a cache, then serves the cache without fetching", () =>
  withTmp(async (dir) => {
    const cachePath = path.join(dir, "nested", "cache.json");
    const counter = { n: 0 };
    const opts = { cachePath, repo: REPO, fetchImpl: fakeFetch(ok, counter), now: () => 1000 };

    const first = await loadCatalog(opts);
    assert.equal(first.origin, "live");
    assert.equal(first.models.length, 3);

    const second = await loadCatalog({ ...opts, now: () => 2000 });
    assert.equal(second.origin, "cache");
    assert.equal(counter.n, 1, "fresh cache must not trigger another request");
  }));

test("loadCatalog refetches once the cache is older than the ttl", () =>
  withTmp(async (dir) => {
    const cachePath = path.join(dir, "cache.json");
    const counter = { n: 0 };
    const opts = { cachePath, repo: REPO, ttlMs: 100, fetchImpl: fakeFetch(ok, counter) };
    await loadCatalog({ ...opts, now: () => 0 });
    const again = await loadCatalog({ ...opts, now: () => 500 });
    assert.equal(again.origin, "live");
    assert.equal(counter.n, 2);
  }));

test("loadCatalog serves a stale cache when the network fails", () =>
  withTmp(async (dir) => {
    const cachePath = path.join(dir, "cache.json");
    await loadCatalog({ cachePath, repo: REPO, fetchImpl: fakeFetch(ok), now: () => 0 });
    const result = await loadCatalog({
      cachePath,
      repo: REPO,
      ttlMs: 10,
      now: () => 99999,
      fetchImpl: fakeFetch(() => {
        throw new Error("offline");
      }),
    });
    assert.equal(result.origin, "stale-cache");
    assert.equal(result.models.length, 3);
  }));

test("loadCatalog falls back to the built-in list on failure, HTTP errors, and empty listings", async () => {
  const failing = [
    fakeFetch(() => { throw new Error("offline"); }),
    fakeFetch(() => new Response("nope", { status: 500 })),
    fakeFetch(() => new Response("[]", { status: 200 })),
    fakeFetch(() => new Response("not json", { status: 200 })),
  ];
  for (const fetchImpl of failing) {
    const r = await loadCatalog({ repo: REPO, fetchImpl });
    assert.equal(r.origin, "fallback");
    assert.equal(r.models, FALLBACK_CATALOG);
  }
});

test("loadCatalog ignores a corrupt or wrong-repo cache", () =>
  withTmp(async (dir) => {
    const cachePath = path.join(dir, "cache.json");
    await writeFile(cachePath, "{{{ not json");
    assert.equal((await loadCatalog({ cachePath, repo: REPO, fetchImpl: fakeFetch(ok) })).origin, "live");

    await writeFile(cachePath, JSON.stringify({ fetchedAt: Date.now(), repo: "other/repo", models: FALLBACK_CATALOG }));
    const counter = { n: 0 };
    const r = await loadCatalog({ cachePath, repo: REPO, fetchImpl: fakeFetch(ok, counter) });
    assert.equal(r.origin, "live");
    assert.equal(counter.n, 1);

    const written = JSON.parse(await readFile(cachePath, "utf-8"));
    assert.equal(written.repo, REPO);
  }));

test("loadCatalog requests the right URL", async () => {
  let seen = "";
  const fetchImpl = (async (url: string) => {
    seen = url;
    return ok();
  }) as unknown as typeof fetch;
  await loadCatalog({ repo: REPO, fetchImpl });
  assert.equal(seen, treeUrl(REPO));
});

test("mergeInstalledModels adds locally present models missing from the catalog", () =>
  withTmp(async (dir) => {
    await writeFile(path.join(dir, "Qwen3.5-4B-Q5_K_S.llamafile"), "x"); // already in catalog
    await writeFile(path.join(dir, "Removed-Upstream-3B-Q4_K_M.llamafile"), "xx");
    await writeFile(path.join(dir, "mxbai-embed-large-v1-f16.llamafile"), "x"); // embedding: excluded
    await writeFile(path.join(dir, "Half.llamafile.part"), "x"); // partial download: excluded
    await writeFile(path.join(dir, ".catalog-cache.json"), "{}");

    const catalog: ModelInfo[] = FALLBACK_CATALOG.slice(0, 4);
    const merged = await mergeInstalledModels(catalog, dir);
    const extras = merged.slice(catalog.length);
    assert.deepEqual(extras.map((m) => m.filename), ["Removed-Upstream-3B-Q4_K_M.llamafile"]);
    assert.equal(extras[0]!.name, "Removed Upstream 3B (Q4_K_M)");
  }));

test("mergeInstalledModels tolerates a missing models directory", async () => {
  const catalog = FALLBACK_CATALOG.slice(0, 2);
  assert.equal(await mergeInstalledModels(catalog, "/nonexistent/dir/xyz"), catalog);
});
