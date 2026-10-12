import path from "node:path";

// Characters that let one command string do something other than "run this
// program with these arguments": chaining, pipes, redirection, substitution.
const SHELL_OPERATORS = /[;&|<>`$()\n\r]/;

export interface CommandDecision {
  allowed: boolean;
  reason?: string;
}

// Decides whether the agent may run a command during an eval, where every
// confirmation is automatic.
//
// This is an ACCIDENT GUARD, not a sandbox. It stops a confused model from
// running `rm -rf`, `curl | sh` or chained commands, which is the realistic
// risk with small models. It can NOT stop a determined or buggy program: an
// allowed `node` can still run any script the agent writes. Anyone running
// evals against models they don't trust should use a container or VM.
export function checkCommand(command: string, allowedCommands: string[]): CommandDecision {
  const trimmed = command.trim();
  if (trimmed === "") return { allowed: false, reason: "empty command" };
  if (SHELL_OPERATORS.test(trimmed)) {
    return { allowed: false, reason: "shell operators (; & | < > ` $ ( )) are not allowed during evals" };
  }
  const first = path.basename(trimmed.split(/\s+/)[0]!);
  if (!allowedCommands.includes(first)) {
    return { allowed: false, reason: `"${first}" is not in this task's allowed commands (${allowedCommands.join(", ")})` };
  }
  return { allowed: true };
}
