import path from "node:path";

// Characters that let one command string do something other than "run this
// program with these arguments": chaining, pipes, redirection, substitution.
const SHELL_OPERATORS = /[;&|<>`$()\n\r]/;

// Programs a model reaches for to read or explore files. The agent has
// dedicated tools for this, so the refusal points there.
const FILE_EXPLORATION = new Set(["cat", "ls", "head", "tail", "grep", "rg", "find", "pwd", "wc", "tree", "less", "more", "sed", "awk", "which", "echo", "type"]);

export interface CommandDecision {
  allowed: boolean;
  // Written for the MODEL, not for a person: it is returned to the agent as
  // the result of its command, so it says what to do instead.
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
//
// Refusals explain themselves. A bare "declined" teaches a model nothing, and
// small models often retry the identical command or give up; telling them what
// is allowed (and which tool to use instead) keeps the eval measuring the
// model's ability rather than its luck at guessing the harness's rules.
export function checkCommand(command: string, allowedCommands: string[]): CommandDecision {
  const trimmed = command.trim();
  if (trimmed === "") return { allowed: false, reason: "the command is empty." };

  const allowedList = allowedCommands.join(", ");
  const first = path.basename(trimmed.split(/\s+/)[0]!);

  // `cd /some/dir && node x.mjs` is by far the most common mistake: the model
  // assumes it starts somewhere else. Say where it actually is.
  if (first === "cd") {
    return {
      allowed: false,
      reason: `you are already in the project directory, so do not cd. Run the command directly (for example: node src/main.mjs). Allowed commands: ${allowedList}.`,
    };
  }
  if (SHELL_OPERATORS.test(trimmed)) {
    return {
      allowed: false,
      reason: `shell operators (; & | < > \` $ ( )) are not allowed, so run one plain command at a time (for example: node --test). Allowed commands: ${allowedList}.`,
    };
  }
  if (!allowedCommands.includes(first)) {
    const hint = FILE_EXPLORATION.has(first)
      ? ` To look at files use read_file, list_dir, find_files or search_code instead.`
      : "";
    return {
      allowed: false,
      reason: `"${first}" is not available here. Allowed commands: ${allowedList}.${hint}`,
    };
  }
  return { allowed: true };
}
