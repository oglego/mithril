import { spawnSync } from "node:child_process";
import path from "node:path";
import type { ChatMessage, Tool } from "../types.js";
import type { LlamaClientConfig } from "../client/llama-client.js";
import { runAgentTurn, type AgentObserver, type StopReason, type ToolOutcome } from "../agent/agent-loop.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { ContextManager } from "../agent/context-manager.js";
import { tools as baseTools, withMutatingTools } from "../agent/tools.js";
import { checkCommand } from "./policy.js";
import { applySolution, changedFiles, createWorkdir, snapshotDir, writeReply } from "./tasks.js";
import type { CheckResult, FailureKind, RunMetrics, RunResult, TaskSpec } from "./types.js";

const MAX_CHECK_OUTPUT = 1500;

// When this process is itself running under `node --test` (CI, or our own
// test suite), Node sets NODE_TEST_CONTEXT in the environment. Any `node
// --test` started by a child then detects it is "nested" and silently skips
// running tests while still exiting 0: a vacuous pass. Children of an eval
// (the checks, and commands the agent runs) must never inherit it.
const LEAKY_ENV = ["NODE_TEST_CONTEXT"];

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of LEAKY_ENV) delete env[key];
  return env;
}
const MAX_REPLY = 4000;

// The same tool set the chat app builds (via the shared helper), with
// confirmations answered automatically. Edits are always approved; commands
// go through the accident-guard policy.
export function buildEvalTools(allowedCommands: string[], onDeclinedCommand?: (cmd: string) => void): Tool[] {
  return withMutatingTools(baseTools, {
    confirm: async () => true,
    confirmCommand: async (command) => {
      const decision = checkCommand(command, allowedCommands);
      if (decision.allowed) return true;
      onDeclinedCommand?.(command);
      return { approved: false, reason: decision.reason ?? "this command is not allowed." };
    },
  });
}

// Runs a task's check.mjs against a project directory. The check lives in the
// task directory, outside the project, so the agent can't read or edit it.
// Exit code 0 means pass. Note that this executes code the agent wrote.
export function runCheck(task: TaskSpec, workdir: string, replyFile: string): CheckResult {
  const result = spawnSync(process.execPath, [path.join(task.dir, "check.mjs"), workdir, replyFile], {
    cwd: workdir,
    env: cleanEnv(),
    encoding: "utf-8",
    timeout: task.checkTimeoutSeconds * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(0, MAX_CHECK_OUTPUT);
  return {
    passed: !timedOut && result.status === 0,
    exitCode: result.status,
    timedOut,
    output: timedOut ? `check timed out after ${task.checkTimeoutSeconds}s` : output,
  };
}

export function emptyMetrics(): RunMetrics {
  return {
    modelCalls: 0,
    promptTokens: null,
    peakPromptTokens: null,
    completionTokens: null,
    toolCalls: 0,
    toolCallsByName: {},
    outcomes: { ok: 0, unknown_tool: 0, bad_arguments: 0, tool_exception: 0, tool_error: 0, declined: 0 },
    compactions: 0,
  };
}

export function classifyFailure(
  task: TaskSpec,
  stopReason: StopReason,
  changed: string[],
  reply = "x"
): FailureKind {
  switch (stopReason) {
    case "aborted":
      return "timeout";
    case "max_steps":
      return "max_steps";
    case "context":
      return "context_limit";
    case "server_error":
      return "server_error";
    case "answered":
      // An empty final message is its own problem (small "thinking" models
      // sometimes put everything in a separate reasoning field and leave the
      // content blank); calling it a wrong answer would hide that.
      if (reply.trim() === "") return "empty_reply";
      if (task.type === "answer") return "wrong_answer";
      return changed.length === 0 ? "no_changes" : "check_failed";
  }
}

export interface RunTaskOptions {
  chatConfig: LlamaClientConfig;
  contextWindow: number;
  temperature?: number | undefined;
  run: number;
  keepWorkdir?: boolean;
  // Aborts the run from outside (e.g. Ctrl+C). The result then has stopReason
  // "aborted" and is not a real failure of the model.
  signal?: AbortSignal | undefined;
  // Which transcripts to keep in the result. Failures by default: they are
  // the ones you need to read, and transcripts can be large.
  transcripts?: "all" | "failed" | "none";
  onWorkdir?: ((workdir: string) => void) | undefined;
}

// One run of one task: copy the fixture into a scratch directory, point the
// tools at it, run the real agent loop with automatic confirmations, then
// grade the result with the task's check. Runs must not overlap: the project
// root is process-wide state (MITHRIL_PROJECT_ROOT).
export async function runTask(task: TaskSpec, options: RunTaskOptions): Promise<RunResult> {
  const { workdir, replyFile, cleanup } = await createWorkdir(task);
  options.onWorkdir?.(workdir);
  const before = await snapshotDir(workdir);

  const metrics = emptyMetrics();
  let stopReason: StopReason = "answered";
  const observer: AgentObserver = {
    onModelCall: (info) => {
      metrics.modelCalls++;
      if (info.promptTokens !== undefined) {
        metrics.promptTokens = (metrics.promptTokens ?? 0) + info.promptTokens;
        metrics.peakPromptTokens = Math.max(metrics.peakPromptTokens ?? 0, info.promptTokens);
      }
      if (info.completionTokens !== undefined) {
        metrics.completionTokens = (metrics.completionTokens ?? 0) + info.completionTokens;
      }
    },
    onToolResult: (info) => {
      metrics.toolCalls++;
      metrics.toolCallsByName[info.name] = (metrics.toolCallsByName[info.name] ?? 0) + 1;
      metrics.outcomes[info.outcome as ToolOutcome]++;
    },
    onStop: (reason) => {
      stopReason = reason;
    },
  };

  const evalTools = buildEvalTools(task.allowedCommands);
  const history: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(evalTools) },
    { role: "user", content: task.prompt },
  ];
  const manager = new ContextManager({ contextWindow: options.contextWindow });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), task.timeoutSeconds * 1000);
  const abortFromOutside = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortFromOutside, { once: true });
  // Commands the agent runs inherit process.env (see executor.ts), so the
  // process-wide state is adjusted for the duration of the run and restored.
  const previousRoot = process.env.MITHRIL_PROJECT_ROOT;
  const previousLeaky = LEAKY_ENV.map((key) => [key, process.env[key]] as const);
  process.env.MITHRIL_PROJECT_ROOT = workdir;
  for (const key of LEAKY_ENV) delete process.env[key];

  const started = Date.now();
  let reply: string;
  try {
    reply = await runAgentTurn(
      history,
      evalTools,
      { ...options.chatConfig, temperature: options.temperature, signal: controller.signal },
      undefined,
      task.maxSteps,
      { manager, onCompact: () => metrics.compactions++ },
      observer
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromOutside);
    if (previousRoot === undefined) delete process.env.MITHRIL_PROJECT_ROOT;
    else process.env.MITHRIL_PROJECT_ROOT = previousRoot;
    for (const [key, value] of previousLeaky) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const durationMs = Date.now() - started;

  try {
    const changed = changedFiles(before, await snapshotDir(workdir));
    await writeReply(replyFile, reply);
    const check = runCheck(task, workdir, replyFile);

    const result: RunResult = {
      task: task.id,
      run: options.run,
      passed: check.passed,
      stopReason,
      durationMs,
      changedFiles: changed,
      reply: reply.slice(0, MAX_REPLY),
      metrics,
      check,
    };
    if (!check.passed) result.failureKind = classifyFailure(task, stopReason, changed, reply);

    const keep = options.transcripts ?? "failed";
    if (keep === "all" || (keep === "failed" && !check.passed)) result.transcript = history;
    return result;
  } finally {
    if (!options.keepWorkdir) await cleanup();
  }
}

export interface VerifyResult {
  id: string;
  // The untouched fixture must NOT already pass, or the task proves nothing.
  fixtureFails: boolean;
  // The reference solution must pass, or the check is unsatisfiable.
  solutionPasses: boolean;
  detail: string;
}

// Validates a task without any model: the unmodified fixture has to fail its
// check, and the fixture with the reference solution applied has to pass.
export async function verifyTask(task: TaskSpec): Promise<VerifyResult> {
  const unsolved = await createWorkdir(task);
  const solved = await createWorkdir(task);
  try {
    await writeReply(unsolved.replyFile, "");
    const before = runCheck(task, unsolved.workdir, unsolved.replyFile);

    const reply = await applySolution(task, solved.workdir);
    await writeReply(solved.replyFile, reply);
    const after = runCheck(task, solved.workdir, solved.replyFile);

    const detail = [
      before.passed ? "the unmodified fixture already passes" : "",
      after.passed ? "" : `solution rejected: ${after.output.split("\n")[0] ?? ""}`,
    ]
      .filter(Boolean)
      .join("; ");
    return { id: task.id, fixtureFails: !before.passed, solutionPasses: after.passed, detail };
  } finally {
    await unsolved.cleanup();
    await solved.cleanup();
  }
}
