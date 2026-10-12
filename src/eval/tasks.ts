import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { TaskSpec, TaskType } from "./types.js";

export class TaskError extends Error {}

function positiveInt(value: unknown, fallback: number, field: string, id: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TaskError(`Task "${id}": ${field} must be a positive whole number.`);
  }
  return value;
}

// A task is a directory:
//   task.json     id (must equal the directory name), title, prompt, and
//                 optional type, max_steps, timeout_seconds,
//                 check_timeout_seconds, allowed_commands
//   fixture/      the starting project the agent works in
//   check.mjs     grades the result; runs OUTSIDE the project, so the agent
//                 can neither see nor edit it
//   solution/     a reference solution (used by --verify-tasks); an answer
//                 task provides solution/reply.txt instead of files
export async function loadTask(dir: string): Promise<TaskSpec> {
  const absolute = path.resolve(dir);
  const dirName = path.basename(absolute);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(absolute, "task.json"), "utf-8"));
  } catch (err) {
    throw new TaskError(`Task directory "${dirName}": cannot read task.json (${(err as Error).message}).`);
  }
  if (!raw || typeof raw !== "object") throw new TaskError(`Task "${dirName}": task.json must be an object.`);
  const t = raw as Record<string, unknown>;

  if (t.id !== dirName) throw new TaskError(`Task "${dirName}": "id" must equal the directory name (got ${JSON.stringify(t.id)}).`);
  if (typeof t.prompt !== "string" || t.prompt.trim() === "") throw new TaskError(`Task "${dirName}": "prompt" is required.`);
  if (typeof t.title !== "string" || t.title.trim() === "") throw new TaskError(`Task "${dirName}": "title" is required.`);
  const type = (t.type ?? "edit") as TaskType;
  if (type !== "edit" && type !== "answer") throw new TaskError(`Task "${dirName}": "type" must be "edit" or "answer".`);

  let allowedCommands = ["node"];
  if (t.allowed_commands !== undefined) {
    if (!Array.isArray(t.allowed_commands) || !t.allowed_commands.every((c) => typeof c === "string" && c.length > 0)) {
      throw new TaskError(`Task "${dirName}": allowed_commands must be a list of command names.`);
    }
    allowedCommands = t.allowed_commands as string[];
  }

  if (!existsSync(path.join(absolute, "fixture"))) throw new TaskError(`Task "${dirName}": missing fixture/ directory.`);
  if (!existsSync(path.join(absolute, "check.mjs"))) throw new TaskError(`Task "${dirName}": missing check.mjs.`);

  return {
    id: dirName,
    title: t.title,
    prompt: t.prompt,
    type,
    maxSteps: positiveInt(t.max_steps, 15, "max_steps", dirName),
    timeoutSeconds: positiveInt(t.timeout_seconds, 300, "timeout_seconds", dirName),
    checkTimeoutSeconds: positiveInt(t.check_timeout_seconds, 30, "check_timeout_seconds", dirName),
    allowedCommands,
    dir: absolute,
  };
}

// Loads every task in a directory. Entries starting with "_" or "." (shared
// helpers such as _lib.mjs) are not tasks.
export async function loadTasks(root: string): Promise<TaskSpec[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    throw new TaskError(`Cannot read tasks directory "${root}".`);
  }
  const tasks: TaskSpec[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    if (!(await stat(path.join(root, name))).isDirectory()) continue;
    tasks.push(await loadTask(path.join(root, name)));
  }
  if (tasks.length === 0) throw new TaskError(`No tasks found in "${root}".`);
  return tasks;
}

export function selectTasks(all: TaskSpec[], ids: string[] | undefined): TaskSpec[] {
  if (!ids || ids.length === 0) return all;
  const known = new Map(all.map((t) => [t.id, t]));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new TaskError(`Unknown task(s): ${missing.join(", ")}. Available: ${all.map((t) => t.id).join(", ")}.`);
  }
  return ids.map((id) => known.get(id)!);
}

export interface Workdir {
  workdir: string;
  // The reply file lives outside the workdir so the agent can't see or alter it.
  replyFile: string;
  cleanup: () => Promise<void>;
}

// Copies the task's fixture into a fresh scratch directory.
export async function createWorkdir(task: TaskSpec): Promise<Workdir> {
  const root = await mkdtemp(path.join(os.tmpdir(), `mithril-eval-${task.id}-`));
  const workdir = path.join(root, "project");
  await cp(path.join(task.dir, "fixture"), workdir, { recursive: true });
  return {
    workdir,
    replyFile: path.join(root, "reply.txt"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// Relative path -> content hash, for detecting what the agent changed.
export async function snapshotDir(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        out.set(path.relative(dir, full).split(path.sep).join("/"), createHash("sha1").update(await readFile(full)).digest("hex"));
      }
    }
  }
  await walk(dir);
  return out;
}

export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [file, hash] of after) if (before.get(file) !== hash) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

// Copies a task's reference solution over a workdir (reply.txt excluded).
export async function applySolution(task: TaskSpec, workdir: string): Promise<string> {
  const solutionDir = path.join(task.dir, "solution");
  if (!existsSync(solutionDir)) throw new TaskError(`Task "${task.id}": missing solution/ directory.`);
  let reply = "";
  for (const entry of await readdir(solutionDir, { withFileTypes: true })) {
    const from = path.join(solutionDir, entry.name);
    if (entry.name === "reply.txt") {
      reply = await readFile(from, "utf-8");
      continue;
    }
    await mkdir(path.dirname(path.join(workdir, entry.name)), { recursive: true });
    await cp(from, path.join(workdir, entry.name), { recursive: true });
  }
  if (task.type === "answer" && reply === "") throw new TaskError(`Task "${task.id}": an answer task needs solution/reply.txt.`);
  return reply;
}

export async function writeReply(file: string, reply: string): Promise<void> {
  await writeFile(file, reply, "utf-8");
}
