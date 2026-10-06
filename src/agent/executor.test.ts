import { test } from "node:test";
import assert from "node:assert/strict";
import { executeCommand } from "./executor.js";

test("executeCommand runs command and captures output and exit code 0", async () => {
  const result = await executeCommand("node -e \"console.log('hello stdout')\"", process.cwd());

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /hello stdout/);
  assert.equal(result.timedOut, false);
});

test("executeCommand captures stderr and non-zero exit code", async () => {
  const result = await executeCommand("node -e \"console.error('custom error'); process.exit(42)\"", process.cwd());

  assert.equal(result.exitCode, 42);
  assert.match(result.output, /custom error/);
  assert.equal(result.timedOut, false);
});

test("executeCommand times out long-running commands", async () => {
  const result = await executeCommand("node -e \"setTimeout(() => {}, 5000)\"", process.cwd(), {
    timeoutSeconds: 1,
  });

  assert.equal(result.timedOut, true);
  assert.match(result.output, /timed out/);
});

test("executeCommand truncates excessive output", async () => {
  const result = await executeCommand("node -e \"console.log('a'.repeat(2000))\"", process.cwd(), {
    maxOutputChars: 500,
  });

  assert.match(result.output, /Output truncated: showing last 500 characters/);
});
