import type { ChatMessage } from "../types.js";
import type { StopReason, ToolOutcome } from "../agent/agent-loop.js";

export type TaskType = "edit" | "answer";

export interface TaskSpec {
  id: string;
  title: string;
  prompt: string;
  // "edit": the agent is expected to change files. "answer": it is expected
  // to reply with information and the reply is what gets graded.
  type: TaskType;
  maxSteps: number;
  timeoutSeconds: number;
  checkTimeoutSeconds: number;
  // First words the agent may run via run_command. An accident guard, not a
  // sandbox (see policy.ts).
  allowedCommands: string[];
  // Absolute path of the task directory.
  dir: string;
}

export type FailureKind =
  | "empty_reply" // the model's final message was empty (so it neither answered nor finished a task)
  | "check_failed" // finished, changed files, but the check rejected the result
  | "no_changes" // finished without changing any file on an edit task
  | "wrong_answer" // answer task whose reply the check rejected
  | "max_steps"
  | "timeout"
  | "context_limit"
  | "server_error";

export interface CheckResult {
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  // First part of the check's output, kept to explain failures.
  output: string;
}

export interface RunMetrics {
  modelCalls: number;
  // Summed over calls; null when the server never reported usage.
  promptTokens: number | null;
  // Largest single prompt, which is what a small context window cares about.
  peakPromptTokens: number | null;
  completionTokens: number | null;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  outcomes: Record<ToolOutcome, number>;
  compactions: number;
}

export interface RunResult {
  task: string;
  run: number;
  passed: boolean;
  failureKind?: FailureKind;
  stopReason: StopReason;
  durationMs: number;
  changedFiles: string[];
  reply: string;
  metrics: RunMetrics;
  check: CheckResult;
  // Kept for failed runs by default, to make failures debuggable.
  transcript?: ChatMessage[];
}

export interface EvalReport {
  schemaVersion: 1;
  // True while a run is in progress or when it was interrupted: the results
  // cover only plannedRuns' first runs. Absent/false means the run finished.
  partial?: boolean;
  plannedRuns?: number;
  label: string;
  startedAt: string;
  finishedAt: string;
  node: string;
  backend: { baseUrl: string; model: string };
  contextWindow: { window: number; source: string };
  temperature: number | null;
  runsPerTask: number;
  // Fixed prompt cost, and a fingerprint of the exact system prompt + tool
  // definitions, so comparing two reports shows whether the prompt differed.
  fixedOverheadTokens: number;
  promptFingerprint: string;
  tasks: { id: string; title: string; type: TaskType; runs: RunResult[] }[];
}
