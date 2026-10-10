import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  createWriteFileTool,
  createEditFileTool,
  listDirTool,
  findFilesTool,
  searchCodeTool,
  runCommandTool,
  createRunCommandTool,
  tools as toolsExport,
} from "./tools.js";
import { backupRegistry } from "./file-editor.js";
import { readFile } from "node:fs/promises";

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

test("uses an explicit project-root override instead of the ambient working directory", async () => {
  const overrideRoot = await mkdtemp(path.join(tmpdir(), "mithril-override-"));
  const originalRoot = process.env.MITHRIL_PROJECT_ROOT;

  try {
    await writeFile(path.join(overrideRoot, "allowed.txt"), "override content");
    process.env.MITHRIL_PROJECT_ROOT = overrideRoot;

    const result = await readFileTool.execute({ path: "allowed.txt" });
    assert.equal(result, "override content");
  } finally {
    if (originalRoot === undefined) delete process.env.MITHRIL_PROJECT_ROOT;
    else process.env.MITHRIL_PROJECT_ROOT = originalRoot;
    await rm(overrideRoot, { recursive: true, force: true });
  }
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

test("reads a slice of lines with start_line and line_count", async () => {
  const multiline = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");
  await writeFile(path.join(projectRoot, "multiline.txt"), multiline);

  const result = await readFileTool.execute({
    path: "multiline.txt",
    start_line: 2,
    line_count: 2,
  });

  assert.match(result, /^line 2\nline 3/);
  assert.match(result, /\[Showing lines 2-3 of 5\. Use start_line=4 to read further\.\]/);
});

test("formats output with line numbers when requested", async () => {
  const multiline = ["first", "second", "third"].join("\n");
  await writeFile(path.join(projectRoot, "numbered.txt"), multiline);

  const result = await readFileTool.execute({
    path: "numbered.txt",
    start_line: 1,
    line_count: 2,
    line_numbers: true,
  });

  assert.match(result, /^1: first\n2: second/);
});

test("returns an explicit truncation footer when a large file exceeds the page limit", async () => {
  const lines = Array.from({ length: 200 }, (_, i) => `content line ${i + 1}`).join("\n");
  await writeFile(path.join(projectRoot, "large.txt"), lines);

  const result = await readFileTool.execute({ path: "large.txt" });

  assert.match(result, /\[File truncated: showing lines 1-100 of 200\. Use start_line=101 to read further\.\]/);
  assert.match(result, /^content line 1/);
});

test("rejects invalid start_line and line_count arguments", async () => {
  const invalidStart = await readFileTool.execute({ path: "allowed.txt", start_line: 0 });
  assert.match(invalidStart, /must be a positive integer/);

  const invalidCount = await readFileTool.execute({ path: "allowed.txt", line_count: -5 });
  assert.match(invalidCount, /must be a positive integer/);

  const outOfRange = await readFileTool.execute({ path: "allowed.txt", start_line: 999 });
  assert.match(outOfRange, /is beyond the end of the file/);
});

// --- writeFileTool Tests ---

test("writeFileTool creates a new file inside the project directory", async () => {
  const result = await writeFileTool.execute({
    path: "src/new-file.txt",
    content: "hello world",
  });

  assert.match(result, /Successfully wrote file/);
  const written = await readFile(path.join(projectRoot, "src/new-file.txt"), "utf-8");
  assert.equal(written, "hello world");
});

test("writeFileTool rejects overwriting existing file unless overwrite=true is passed", async () => {
  const first = await writeFileTool.execute({ path: "exists.txt", content: "initial" });
  assert.match(first, /Successfully wrote file/);

  const second = await writeFileTool.execute({ path: "exists.txt", content: "modified" });
  assert.match(second, /already exists/);

  const third = await writeFileTool.execute({ path: "exists.txt", content: "modified", overwrite: true });
  assert.match(third, /Successfully wrote file/);
  const updated = await readFile(path.join(projectRoot, "exists.txt"), "utf-8");
  assert.equal(updated, "modified");
});

test("writeFileTool blocks writing outside project root", async () => {
  const result = await writeFileTool.execute({ path: "../evil.txt", content: "evil" });
  assert.match(result, /access outside the project directory is not allowed/);
});

test("writeFileTool blocks modifying protected paths like .git and .env", async () => {
  const gitResult = await writeFileTool.execute({ path: ".git/config", content: "broken" });
  assert.match(gitResult, /Git metadata \(\.git\) is protected/);

  const envResult = await writeFileTool.execute({ path: ".env", content: "SECRET=1" });
  assert.match(envResult, /Environment files \(\.env\) are protected/);

  const modelsResult = await writeFileTool.execute({ path: "models/weights.bin", content: "0" });
  assert.match(modelsResult, /Models directory \(models\/\) is protected/);
});

test("writeFileTool respects confirmation hook when declined", async () => {
  const toolWithConfirm = createWriteFileTool({
    confirm: async () => false,
  });

  const result = await toolWithConfirm.execute({ path: "declined.txt", content: "declined" });
  assert.match(result, /declined by the user/);
});

// --- editFileTool Tests ---

test("editFileTool performs exact string replacement", async () => {
  await writeFile(path.join(projectRoot, "edit-target.txt"), "foo bar baz");

  const result = await editFileTool.execute({
    path: "edit-target.txt",
    target_content: "bar",
    replacement_content: "qux",
  });

  assert.match(result, /Successfully updated/);
  const updated = await readFile(path.join(projectRoot, "edit-target.txt"), "utf-8");
  assert.equal(updated, "foo qux baz");
});

test("editFileTool rejects ambiguous match when target_content occurs multiple times without allow_multiple", async () => {
  await writeFile(path.join(projectRoot, "ambiguous.txt"), "repeat repeat repeat");

  const result = await editFileTool.execute({
    path: "ambiguous.txt",
    target_content: "repeat",
    replacement_content: "single",
  });

  assert.match(result, /found 3 times in the file/);
});

test("editFileTool performs whitespace-tolerant matching when indentation differs", async () => {
  const originalCode = "function test() {\n    const x = 1;\n    return x;\n}";
  await writeFile(path.join(projectRoot, "whitespace.ts"), originalCode);

  // Model sends code with 2 spaces instead of 4 spaces indentation
  const targetSnippet = "const x = 1;\n  return x;";
  const replacementSnippet = "const x = 42;\n  return x * 2;";

  const result = await editFileTool.execute({
    path: "whitespace.ts",
    target_content: targetSnippet,
    replacement_content: replacementSnippet,
  });

  assert.match(result, /Successfully updated.*whitespace-tolerant match/);
  const updated = await readFile(path.join(projectRoot, "whitespace.ts"), "utf-8");
  assert.match(updated, /const x = 42;/);
});

test("editFileTool records modifications in backupRegistry for undo", async () => {
  await writeFile(path.join(projectRoot, "undo-target.txt"), "original state");

  await editFileTool.execute({
    path: "undo-target.txt",
    target_content: "original",
    replacement_content: "new",
  });

  const lastBackup = backupRegistry.peek();
  assert.ok(lastBackup);
  assert.equal(lastBackup.content, "original state");
});

// --- Navigation Tools Tests ---

test("listDirTool lists directory contents inside project root", async () => {
  const result = await listDirTool.execute({});
  assert.match(result, /\[FILE\]/);
});

test("listDirTool rejects directory path escaping project root", async () => {
  const result = await listDirTool.execute({ path: "../../outside" });
  assert.match(result, /access outside the project directory is not allowed/);
});

test("findFilesTool finds files in project root", async () => {
  const result = await findFilesTool.execute({ pattern: "*allowed*" });
  assert.match(result, /allowed\.txt/);
});

test("searchCodeTool searches text inside project files", async () => {
  const result = await searchCodeTool.execute({ query: "safe content" });
  assert.match(result, /allowed\.txt:\d+: safe content/);
});

test("searchCodeTool rejects missing query argument", async () => {
  const result = await searchCodeTool.execute({});
  assert.match(result, /missing or invalid "query" argument/);
});

// --- runCommandTool Tests ---

test("runCommandTool executes command and returns exit code and output", async () => {
  const result = await runCommandTool.execute({ command: 'node -e "console.log(12345)"' });
  assert.match(result, /Exit code: 0/);
  assert.match(result, /12345/);
});

test("runCommandTool respects confirmation hook when declined", async () => {
  const toolWithConfirm = createRunCommandTool({
    confirmCommand: async () => false,
  });

  const result = await toolWithConfirm.execute({ command: "node -v" });
  assert.match(result, /Command execution was declined by the user/);
});

test("runCommandTool rejects invalid or missing command argument", async () => {
  const missing = await runCommandTool.execute({});
  assert.match(missing, /missing or invalid "command" argument/);

  const empty = await runCommandTool.execute({ command: "   " });
  assert.match(empty, /missing or invalid "command" argument/);
});

// --- Code review regression tests ---

test("write_file can create a file under a nested 'models' directory (e.g. src/models/)", async () => {
  // Pins the fix for an unanchored path check: only the repo-root models/
  // directory (downloaded llamafile binaries) should be protected, not any
  // path segment literally named "models" at any depth — src/models/ is
  // ordinary source code.
  const result = await writeFileTool.execute({
    path: "src/models/catalog.ts",
    content: "export const x = 1;",
  });
  assert.equal(result, 'Successfully wrote file "src/models/catalog.ts".');
});

test("write_file still protects the actual repo-root models/ directory", async () => {
  const result = await writeFileTool.execute({
    path: "models/some-llamafile-binary",
    content: "not a real binary",
  });
  assert.match(result, /Models directory \(models\/\) is protected/);
});

test("write_file edits (not just creates) under src/models/ without being blocked", async () => {
  await writeFileTool.execute({ path: "src/models/paths.ts", content: "v1" });
  const result = await writeFileTool.execute({
    path: "src/models/paths.ts",
    content: "v2",
    overwrite: true,
  });
  assert.equal(result, 'Successfully wrote file "src/models/paths.ts".');
});

test("the default tools array does not include write_file, edit_file, or run_command", () => {
  // These are capability-dangerous enough (arbitrary writes, arbitrary
  // shell execution) that they must only ever exist with a confirmation
  // callback wired in. Pins that they're absent from the default set
  // rather than relying on every caller to remember to swap them out.
  const dangerousNames = ["write_file", "edit_file", "run_command"];
  for (const name of dangerousNames) {
    assert.equal(
      toolsExport.some((t) => t.name === name),
      false,
      `${name} should not be in the default tools array`
    );
  }
});

test("write_file rejects creating a new file inside a symlinked directory that escapes the project", async () => {
  // The target file ("escape-dir/new.txt") doesn't exist yet, so it can't
  // be realpath'd directly — this pins the nearest-existing-ancestor check
  // that catches the symlinked parent directory instead.
  const linkPath = path.join(projectRoot, "escape-dir");
  await symlink(outsideDir, linkPath);

  try {
    const result = await writeFileTool.execute({
      path: "escape-dir/new.txt",
      content: "should never land outside the project",
    });
    assert.match(result, /escapes the project directory/);
  } finally {
    await rm(linkPath, { force: true });
  }
});

