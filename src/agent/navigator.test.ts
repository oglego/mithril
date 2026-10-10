import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listDirectory, findFiles, searchCode } from "./navigator.js";

let testRoot: string;

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), "mithril-nav-"));

  // Setup directory structure
  await mkdir(path.join(testRoot, "src/sub"), { recursive: true });
  await mkdir(path.join(testRoot, "node_modules/fake-pkg"), { recursive: true });
  await mkdir(path.join(testRoot, "models"), { recursive: true });

  await writeFile(path.join(testRoot, "package.json"), '{"name": "test-pkg"}');
  await writeFile(path.join(testRoot, "src/index.ts"), "export const hello = 'world';\nconsole.log(hello);");
  await writeFile(path.join(testRoot, "src/sub/helper.ts"), "export function helper() {\n  return 42;\n}");
  await writeFile(path.join(testRoot, "node_modules/fake-pkg/index.js"), "module.exports = {};");
  await writeFile(path.join(testRoot, "models/model.llamafile"), "binary-weights");
});

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

test("listDirectory lists files and directories with sizes", async () => {
  const result = await listDirectory(testRoot, testRoot);

  assert.match(result, /\[DIR\]\s+src\//);
  assert.match(result, /\[FILE\]\s+package\.json/);
});

test("findFiles finds files matching extension and pattern", async () => {
  const tsFiles = await findFiles(testRoot, testRoot, { extension: "ts" });
  assert.match(tsFiles, /src\/index\.ts/);
  assert.match(tsFiles, /src\/sub\/helper\.ts/);
  assert.doesNotMatch(tsFiles, /package\.json/);

  // Pattern matching
  const helperOnly = await findFiles(testRoot, testRoot, { pattern: "*helper*" });
  assert.match(helperOnly, /src\/sub\/helper\.ts/);
  assert.doesNotMatch(helperOnly, /src\/index\.ts/);
});

test("findFiles ignores node_modules and models directories", async () => {
  const allFiles = await findFiles(testRoot, testRoot);

  assert.doesNotMatch(allFiles, /node_modules/);
  assert.doesNotMatch(allFiles, /models/);
});

test("findFiles and searchCode still traverse a nested directory literally named 'models'", async () => {
  // "models" has root-only exclusion semantics (Mithril's downloaded-
  // binaries folder) — a nested directory that happens to share the name,
  // like src/models/, is ordinary source code and should stay searchable.
  await mkdir(path.join(testRoot, "src/models"), { recursive: true });
  await writeFile(path.join(testRoot, "src/models/catalog.ts"), "export const findMe = true;");

  try {
    const files = await findFiles(testRoot, testRoot, { extension: "ts" });
    assert.match(files, /src\/models\/catalog\.ts/);

    const searchResult = await searchCode(testRoot, testRoot, { query: "findMe" });
    assert.match(searchResult, /src\/models\/catalog\.ts/);
  } finally {
    await rm(path.join(testRoot, "src/models"), { recursive: true, force: true });
  }
});

test("searchCode finds matching text lines with line numbers and paths", async () => {
  const searchResult = await searchCode(testRoot, testRoot, { query: "hello" });

  assert.match(searchResult, /src\/index\.ts:1:\s*export const hello/);
  assert.match(searchResult, /src\/index\.ts:2:\s*console\.log\(hello\);/);
});

test("searchCode supports regular expressions", async () => {
  const regexResult = await searchCode(testRoot, testRoot, { query: "helper\\(\\)", isRegex: true });

  assert.match(regexResult, /src\/sub\/helper\.ts:1:\s*export function helper\(\)/);
});

test("searchCode ignores binary extensions and ignored directories", async () => {
  const result = await searchCode(testRoot, testRoot, { query: "binary-weights" });

  assert.match(result, /No matches found/);
});
