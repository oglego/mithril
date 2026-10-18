import path from "node:path";
import { launchLlamafile, stopAll } from "./backend.js";
import { ConfigError, parseFlag, parsePathFlag, parsePortFlag, probeBackend, resolveBackend } from "./config.js";
import { describeWindow, parseContextFlag, resolveContextWindow } from "./context-window.js";
import { runAgentTurn, type AgentObserver, type StopReason, type ToolOutcome } from "./agent/agent-loop.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { ContextManager, formatCompactionReport } from "./agent/context-manager.js";
import { tools as baseTools, withMutatingTools } from "./agent/tools.js";
import { checkCommand } from "./eval/policy.js";
import { loadSkills } from "./skills/loader.js";
import { createLoadSkillTool } from "./skills/skill-tool.js";
import type { ChatMessage, Tool } from "./types.js";

// Exit codes, so scripts and CI can tell "it worked" from "it couldn't run"
// from "it ran out of steps". 124 and 130 follow timeout(1) and SIGINT.
export const EXIT = {
  OK: 0,
  FAILED: 1, // server error, or the request no longer fits the context window
  USAGE: 2, // bad flags or missing configuration; nothing was run
  MAX_STEPS: 3, // the agent used all its steps without finishing
  TIMEOUT: 124,
  INTERRUPTED: 130,
} as const;

export function exitCodeFor(reason: StopReason, timedOut: boolean): number {
  switch (reason) {
    case "answered":
      return EXIT.OK;
    case "max_steps":
      return EXIT.MAX_STEPS;
    case "aborted":
      return timedOut ? EXIT.TIMEOUT : EXIT.INTERRUPTED;
    default:
      return EXIT.FAILED; // server_error, context
  }
}

export const HEADLESS_HELP = `Usage: mithril -p "<prompt>" (--llamafile <path> | --base-url <url> --model <id>) [options]

Runs one task without any prompts and exits. The answer goes to stdout;
progress and warnings go to stderr, so the output is safe to pipe.

Model (required; headless mode never opens the model picker):
  --llamafile <path>              start this llamafile for the run and stop it afterwards
  --port <n>                      the port for --llamafile (default 8080)
  --base-url <url> --model <id>   or use a server that is already running
                                  (or set MITHRIL_BASE_URL and MITHRIL_MODEL)
  --context <tokens>              context window size
  --temperature <0-2>             sampling temperature (use 0 for repeatable runs)

Prompt:
  -p, --print "<prompt>"          the task. With no value (or "-"), the prompt is read from stdin

Permissions (read-only by default; what you don't allow is not even offered to the model):
  --allow-write                   let the agent create and edit files in the project
  --allow-command <programs>      let the agent run these programs, e.g. node,npm
                                  (program names only; may be repeated; chaining, pipes and
                                  redirection are refused). This is an accident guard, not a
                                  sandbox: an allowed program can still run anything it can run.

Output and limits:
  --output-format <text|json>     text (default) or one JSON object on stdout
  --max-steps <n>                 model/tool steps, 1-100 (default 15)
  --timeout <seconds>             stop after this long (default: no limit)
  --skills <dir>                  load skills from a directory
  --verbose                       log tool calls to stderr

Exit codes: 0 answered, 1 failed, 2 usage or configuration error,
            3 out of steps, 124 timed out, 130 interrupted.
`;

export interface HeadlessOptions {
  // undefined means "read it from stdin".
  prompt: string | undefined;
  outputFormat: "text" | "json";
  allowWrite: boolean;
  allowCommands: string[];
  verbose: boolean;
  help: boolean;
  maxSteps: number;
  timeoutSeconds: number | undefined;
  temperature: number | undefined;
  skillsDir: string | undefined;
}

const VALUE_FLAGS = new Set([
  "--output-format", "--allow-command", "--max-steps", "--timeout", "--skills", "--temperature",
  // read by the shared config code (parseFlag / resolveBackend / parseContextFlag)
  "--base-url", "--model", "--context", "--api-key", "--llamafile", "--port",
]);
const BOOLEAN_FLAGS = new Set(["--allow-write", "--verbose", "--help", "-h"]);
const UNSUPPORTED = new Map([["--docs", "--docs is not supported in headless mode yet."]]);

const PROGRAM_NAME = /^[A-Za-z0-9._+-]+$/;

function numberFlag(flag: string, raw: string, ok: (n: number) => boolean, expected: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || !ok(value)) {
    throw new ConfigError(`${flag} must be ${expected} (got "${raw}").`);
  }
  return value;
}

// Strict on purpose: a typo like --allow-writes must be an error, not a
// silently ignored flag, because in headless mode nobody is watching.
export function parseHeadlessArgs(argv: string[]): HeadlessOptions {
  const opts: HeadlessOptions = {
    prompt: undefined,
    outputFormat: "text",
    allowWrite: false,
    allowCommands: [],
    verbose: false,
    help: false,
    maxSteps: 15,
    timeoutSeconds: undefined,
    temperature: undefined,
    skillsDir: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "-p" || arg === "--print") {
      const next = argv[i + 1];
      if (next !== undefined && next !== "-" && !next.startsWith("--")) {
        opts.prompt = next;
        i++;
      } else if (next === "-") {
        i++; // explicit "read stdin"
      }
      continue;
    }

    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === "--allow-write") opts.allowWrite = true;
      else if (arg === "--verbose") opts.verbose = true;
      else opts.help = true;
      continue;
    }

    if (UNSUPPORTED.has(arg)) throw new ConfigError(UNSUPPORTED.get(arg)!);

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new ConfigError(`${arg} needs a value.`);
      i++;
      switch (arg) {
        case "--output-format":
          if (value !== "text" && value !== "json") {
            throw new ConfigError(`--output-format must be "text" or "json" (got "${value}").`);
          }
          opts.outputFormat = value;
          break;
        case "--allow-command":
          for (const name of value.split(",").map((s) => s.trim()).filter(Boolean)) {
            if (!PROGRAM_NAME.test(name)) {
              throw new ConfigError(
                `--allow-command takes program names such as node,npm, not "${name}". ` +
                  `Allowing a program allows any arguments to it.`
              );
            }
            if (!opts.allowCommands.includes(name)) opts.allowCommands.push(name);
          }
          break;
        case "--max-steps":
          opts.maxSteps = numberFlag(arg, value, (n) => Number.isInteger(n) && n >= 1 && n <= 100, "a whole number from 1 to 100");
          break;
        case "--timeout":
          opts.timeoutSeconds = numberFlag(arg, value, (n) => n > 0, "a positive number of seconds");
          break;
        case "--temperature":
          opts.temperature = numberFlag(arg, value, (n) => n >= 0 && n <= 2, "a number from 0 to 2");
          break;
        case "--skills":
          opts.skillsDir = path.resolve(value);
          break;
        // --base-url / --model / --context / --api-key are read later.
      }
      continue;
    }

    if (arg.startsWith("-")) {
      throw new ConfigError(`Unknown option ${arg}. Run mithril -p --help for the list.`);
    }
    throw new ConfigError(`Unexpected argument "${arg}". Put the whole prompt in quotes after -p.`);
  }

  return opts;
}

// What the agent did to files, tracked from approved edits: the confirmation
// callback sees the path, and the tool result says whether the write worked.
export interface FileTracker {
  pending: string | undefined;
  changed: Set<string>;
}

export function newFileTracker(): FileTracker {
  return { pending: undefined, changed: new Set() };
}

// The same tool set as the chat app, with the confirmations answered by the
// flags instead of a person. Anything not allowed is left out entirely so the
// model doesn't waste steps on tools that can only fail; the callbacks still
// refuse as a second line of defence.
export function buildHeadlessTools(
  opts: Pick<HeadlessOptions, "allowWrite" | "allowCommands">,
  tracker: FileTracker,
  base: Tool[] = baseTools
): Tool[] {
  const all = withMutatingTools(base, {
    confirm: async (details) => {
      if (!opts.allowWrite) return false;
      tracker.pending = details.relativePath;
      return true;
    },
    confirmCommand: async (command) => {
      const decision = checkCommand(command, opts.allowCommands);
      if (decision.allowed) return true;
      return { approved: false, reason: decision.reason ?? "this command is not allowed." };
    },
  });
  return all.filter((tool) => {
    if (tool.name === "write_file" || tool.name === "edit_file") return opts.allowWrite;
    if (tool.name === "run_command") return opts.allowCommands.length > 0;
    return true;
  });
}

export interface HeadlessIO {
  out: (text: string) => void;
  err: (text: string) => void;
  readStdin: () => Promise<string>;
  stdinIsTTY: boolean;
  env: Record<string, string | undefined>;
}

export function processIO(): HeadlessIO {
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks).toString("utf-8");
    },
    stdinIsTTY: Boolean(process.stdin.isTTY),
    env: process.env,
  };
}

// Credentials the model server needs but commands the agent runs must not
// see: they would otherwise inherit them from this process.
const SECRET_ENV = ["MITHRIL_API_KEY", "OPENAI_API_KEY"];

interface Summary {
  ok: boolean;
  text: string;
  stopReason: StopReason;
  model: string;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  byName: Record<string, number>;
  outcomes: Partial<Record<ToolOutcome, number>>;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  filesChanged: string[];
}

export function formatJson(s: Summary): string {
  return (
    JSON.stringify({
      ok: s.ok,
      ...(s.ok ? { result: s.text } : { error: s.text }),
      stop_reason: s.stopReason,
      model: s.model,
      duration_ms: s.durationMs,
      model_calls: s.modelCalls,
      tool_calls: { total: s.toolCalls, by_name: s.byName, outcomes: s.outcomes },
      usage: { prompt_tokens: s.promptTokens ?? null, completion_tokens: s.completionTokens ?? null },
      files_changed: s.filesChanged,
    }) + "\n"
  );
}

// Ctrl+C while a llamafile is still starting: there is nothing to finish
// cleanly yet, so just leave (the exit hook stops the model server).
function onStartupInterrupt(): never {
  process.exit(EXIT.INTERRUPTED);
}

// Runs one prompt and returns the process exit code. Never calls
// process.exit and never prints outside `io`, so it can be tested.
export async function runHeadless(argv: string[], io: HeadlessIO = processIO()): Promise<number> {
  let wantsJson = false;
  const fail = (message: string, code: number): number => {
    io.err(`mithril: ${message}\n`);
    if (wantsJson) io.out(JSON.stringify({ ok: false, error: message }) + "\n");
    return code;
  };

  let opts: HeadlessOptions;
  try {
    wantsJson = parseFlag(argv, "--output-format") === "json";
    opts = parseHeadlessArgs(argv);
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message, EXIT.USAGE);
    throw err;
  }

  if (opts.help) {
    io.out(HEADLESS_HELP);
    return EXIT.OK;
  }

  try {
    let prompt = opts.prompt;
    if (prompt === undefined) {
      if (io.stdinIsTTY) throw new ConfigError("No prompt given. Pass -p \"<prompt>\" or pipe the prompt in on stdin.");
      prompt = (await io.readStdin()).trim();
    }
    if (prompt.trim() === "") throw new ConfigError("The prompt is empty.");

    const backend = resolveBackend(argv, io.env);
    if (backend.kind === "local") {
      throw new ConfigError(
        "Headless mode needs a model. Pass --llamafile <path>, or --base-url and --model " +
          "(or MITHRIL_BASE_URL and MITHRIL_MODEL) for a server that is already running."
      );
    }
    const contextFlag = parseContextFlag(argv, io.env);

    let target: { baseUrl: string; model: string; apiKey?: string | undefined };
    let contextWindow: ReturnType<typeof resolveContextWindow>;
    if (backend.kind === "remote") {
      target = { baseUrl: backend.baseUrl, model: backend.model, apiKey: backend.apiKey };
      contextWindow = resolveContextWindow({ flag: contextFlag, kind: "remote" });
      const warning = await probeBackend(backend.baseUrl, backend.apiKey);
      if (warning) io.err(`mithril: warning: ${warning}\n`);
    } else {
      // The llamafile is a child process, so it must be stopped on every way
      // out: normally (the finally below), on Ctrl+C while it is starting, and
      // on a second Ctrl+C or any process.exit during the run (the exit hook).
      process.once("exit", stopAll);
      process.once("SIGINT", onStartupInterrupt);
      const started = await launchLlamafile({
        binaryPath: backend.path,
        modelId: path.basename(backend.path),
        port: parsePortFlag(argv),
        contextFlag,
        onStatus: (message) => io.err(`mithril: ${message}\n`),
      });
      process.off("SIGINT", onStartupInterrupt);
      target = started.chatConfig;
      contextWindow = started.contextWindow;
    }
    if (opts.verbose) io.err(`mithril: ${describeWindow(contextWindow)}\n`);

    const tracker = newFileTracker();
    let tools = buildHeadlessTools(opts, tracker);
    const skillsDir = opts.skillsDir ?? parsePathFlag(argv, "--skills");
    if (skillsDir) {
      const skills = await loadSkills(skillsDir);
      if (skills.length > 0) tools = [...tools, createLoadSkillTool(skills)];
      else io.err(`mithril: warning: no SKILL.md files found in ${skillsDir}.\n`);
    }

    const history: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(tools, { headless: true }) },
      { role: "user", content: prompt },
    ];

    // --- measurement ---
    // Assigned from the observer callback, which the compiler cannot see through.
    let stopReason = "answered" as StopReason;
    let modelCalls = 0;
    let toolCalls = 0;
    const byName: Record<string, number> = {};
    const outcomes: Partial<Record<ToolOutcome, number>> = {};
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    const observer: AgentObserver = {
      onModelCall: (info) => {
        modelCalls++;
        if (info.promptTokens !== undefined) promptTokens = (promptTokens ?? 0) + info.promptTokens;
        if (info.completionTokens !== undefined) completionTokens = (completionTokens ?? 0) + info.completionTokens;
      },
      onToolResult: (info) => {
        toolCalls++;
        byName[info.name] = (byName[info.name] ?? 0) + 1;
        outcomes[info.outcome] = (outcomes[info.outcome] ?? 0) + 1;
        if (info.name === "write_file" || info.name === "edit_file") {
          if (info.outcome === "ok" && tracker.pending) tracker.changed.add(tracker.pending);
          tracker.pending = undefined;
        }
      },
      onStop: (reason) => {
        stopReason = reason;
      },
    };

    // --- limits and interruption ---
    const controller = new AbortController();
    let timedOut = false as boolean;
    const timer =
      opts.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, opts.timeoutSeconds * 1000);
    let interrupts = 0;
    const onSigint = () => {
      // First Ctrl+C stops cleanly; a second one means "now".
      if (++interrupts > 1) process.exit(EXIT.INTERRUPTED);
      controller.abort();
    };
    process.on("SIGINT", onSigint);

    // Commands the agent runs inherit process.env (see executor.ts), so the
    // server credentials are removed for the run and put back afterwards. They
    // were already read into `backend` above.
    const savedSecrets = SECRET_ENV.map((key) => [key, process.env[key]] as const);
    for (const key of SECRET_ENV) delete process.env[key];

    const started = Date.now();
    let reply: string;
    try {
      reply = await runAgentTurn(
        history,
        tools,
        { baseUrl: target.baseUrl, model: target.model, apiKey: target.apiKey, temperature: opts.temperature, signal: controller.signal },
        opts.verbose ? (name) => io.err(`mithril: calling ${name}\n`) : undefined,
        opts.maxSteps,
        {
          manager: new ContextManager({ contextWindow: contextWindow.window }),
          onCompact: (report) => {
            if (opts.verbose) io.err(`mithril: ${formatCompactionReport(report)}\n`);
          },
        },
        observer
      );
    } finally {
      if (timer) clearTimeout(timer);
      process.off("SIGINT", onSigint);
      for (const [key, value] of savedSecrets) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const code = exitCodeFor(stopReason, timedOut);
    const ok = code === EXIT.OK;
    const message = stopReason === "aborted" && timedOut ? `(Stopped: timed out after ${opts.timeoutSeconds}s.)` : reply;

    if (opts.outputFormat === "json") {
      io.out(
        formatJson({
          ok,
          text: message,
          stopReason,
          model: target.model,
          durationMs: Date.now() - started,
          modelCalls,
          toolCalls,
          byName,
          outcomes,
          promptTokens,
          completionTokens,
          filesChanged: [...tracker.changed].sort(),
        })
      );
      if (!ok) io.err(`mithril: ${message}\n`);
    } else if (ok) {
      io.out(message.endsWith("\n") ? message : message + "\n");
    } else {
      // Keep stdout empty on failure so `x=$(mithril -p ...)` can't capture an error message as an answer.
      io.err(`mithril: ${message}\n`);
    }
    return code;
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message, EXIT.USAGE);
    return fail(`failed: ${(err as Error).message}`, EXIT.FAILED);
  } finally {
    // A llamafile started for this run goes away with it, whatever happened.
    process.off("exit", stopAll);
    process.off("SIGINT", onStartupInterrupt);
    stopAll();
  }
}
