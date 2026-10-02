import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileTool } from "./tools.js";

// readFileTool resolves paths against process.cwd(), so these tests run
// inside a temporary directory standing in for the project root — real
// files on disk, not mocks, since the behavior under test is filesystem
// path resolution itself.
let projectRoot: string;
let outsideDir: string;
let originalCwd: string;

before(async () => {
  originalCwd = process.cwd();

  projectRoot = await mkdtemp(path.join(tmpdir(), "mithril-test-"));
  outsideDir = await mkdtemp(path.join(tmpdir(), "mithril-outside-"));

  await writeFile(path.join(projectRoot, "allowed.txt"), "safe content");
  await writeFile(path.join(outsideDir, "secret.txt"), "should never be readable");

  process.chdir(projectRoot);
});

after(async () => {
  process.chdir(originalCwd);
  await rm(projectRoot, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

test("reads a file inside the project directory", async () => {
  const result = await readFileTool.execute({ path: "allowed.txt" });
  assert.equal(result, "safe content");
});

test("rejects a relative path that walks upward out of the project", async () => {
  const result = await readFileTool.execute({ path: "../outside-secret.txt" });
  assert.match(result, /not allowed/);
});

test("rejects an absolute path outside the project directory", async () => {
  const result = await readFileTool.execute({ path: path.join(outsideDir, "secret.txt") });
  assert.match(result, /not allowed/);
});

test("rejects a missing path argument", async () => {
  const result = await readFileTool.execute({});
  assert.match(result, /missing or invalid/);
});

test("rejects a non-string path argument", async () => {
  const result = await readFileTool.execute({ path: 12345 });
  assert.match(result, /missing or invalid/);
});

test("rejects a symlink inside the project that points outside it", async () => {
  // This is the exact class of bug the code review flagged: a path can look
  // safe by its own name while resolving to something outside the sandbox.
  const linkPath = path.join(projectRoot, "escape-link.txt");
  await symlink(path.join(outsideDir, "secret.txt"), linkPath);

  const result = await readFileTool.execute({ path: "escape-link.txt" });
  assert.match(result, /escapes the project directory/);
});

test("rejects a sibling directory whose name shares the project root as a string prefix", async () => {
  // This pins the exact historical bug: a plain fullPath.startsWith(root)
  // check treats "/project-evil" as safe because it starts with the string
  // "/project", even though it's a completely different directory. Only a
  // boundary-aware check (path.relative, or startsWith(root + sep)) catches this.
  const siblingDir = `${projectRoot}-evil`;
  await mkdir(siblingDir);
  await writeFile(path.join(siblingDir, "secret.txt"), "should never be readable");

  try {
    const result = await readFileTool.execute({ path: path.join(siblingDir, "secret.txt") });
    assert.match(result, /not allowed/);
  } finally {
    await rm(siblingDir, { recursive: true, force: true });
  }
});

test("returns a clear error for a file that doesn't exist", async () => {
  const result = await readFileTool.execute({ path: "does-not-exist.txt" });
  assert.match(result, /Error reading file/);
});
