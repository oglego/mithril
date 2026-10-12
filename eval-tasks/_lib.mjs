// Helpers shared by the check.mjs scripts. Checks run OUTSIDE the project the
// agent works in (see README), receiving the project directory and the file
// holding the agent's final reply as arguments.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const [workdir, replyFile] = process.argv.slice(2);

export function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

export function pass() {
  process.exit(0);
}

export function ensure(condition, message) {
  if (!condition) fail(message);
}

export function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
}

export async function load(relativePath) {
  const file = path.join(workdir, relativePath);
  if (!existsSync(file)) fail(`${relativePath} does not exist`);
  try {
    return await import(pathToFileURL(file).href);
  } catch (err) {
    return fail(`${relativePath} could not be loaded: ${err.message}`);
  }
}

export function read(relativePath) {
  const file = path.join(workdir, relativePath);
  if (!existsSync(file)) fail(`${relativePath} does not exist`);
  return readFileSync(file, "utf-8");
}

export function reply() {
  return readFileSync(replyFile, "utf-8");
}

export function run(args, timeoutMs = 10000) {
  return spawnSync(process.execPath, args, { cwd: workdir, encoding: "utf-8", timeout: timeoutMs });
}
