```text
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║  ███╗   ███╗ ██╗ ████████╗ ██╗  ██╗ ██████╗  ██╗ ██╗      ║
║  ████╗ ████║ ██║ ╚══██╔══╝ ██║  ██║ ██╔══██╗ ██║ ██║      ║
║  ██╔████╔██║ ██║    ██║    ███████║ ██████╔╝ ██║ ██║      ║
║  ██║╚██╔╝██║ ██║    ██║    ██╔══██║ ██╔══██╗ ██║ ██║      ║
║  ██║ ╚═╝ ██║ ██║    ██║    ██║  ██║ ██║  ██║ ██║ ███████╗ ║
║  ╚═╝     ╚═╝ ╚═╝    ╚═╝    ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚═╝ ╚══════╝ ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
```
# Mithril

Mithril is a small TypeScript command-line coding assistant. By default it downloads a local llamafile model, starts it as a local OpenAI-compatible chat server, and opens a tool-using REPL. It can also connect to any OpenAI-compatible server you already run (Ollama, LM Studio, vLLM, OpenRouter, OpenAI, ...).

The app is designed for a local-first workflow: choose a model from a catalog, download it if it is not already present, launch the model server, and open an agent loop without needing a separate hosted AI service.

## Features

- ASCII-art banner on launch, followed by interactive model selection (`@clack/prompts`)
- Model list discovered live from the Hugging Face repo that hosts the llamafiles, cached for 24 hours, with a built-in list as an offline fallback (see [Model catalog](#model-catalog))
- "Connect to a server…" entry in the picker for Ollama, LM Studio, OpenAI, OpenRouter, or any OpenAI-compatible API
- Automatic download of selected llamafile models into a local `models/` directory, with atomic writes so an interrupted download can't be mistaken for a complete one
- Launches the model with `--server --port 8080 --no-webui --jinja`
- Polls the server health endpoint until it is ready
- Sends chat requests to the OpenAI-compatible `/v1/chat/completions` endpoint
- Runs a tool-calling agent loop with streamed output: answers appear as they are generated, and the model can call local tools, see the results, and respond based on them (see [Streaming](#streaming))
- Coding tools: `read_file`, `list_dir`, `find_files`, `search_code` (read-only), plus `write_file`, `edit_file` and `run_command`, which always ask for confirmation first (diffs are shown for edits). `/undo` reverts the last edited file and `/diff` lists files modified this session
- File tools are sandboxed to the project directory (including symlink checks); `.git`, `.env*` and `models/` are protected from writes
- Bring your own backend: `--base-url` / `--model` point Mithril at any OpenAI-compatible server instead of a local llamafile (see below)
- Context management: the prompt is kept within the model's context window before every model call, by trimming old tool results and condensing old conversation into a short summary instead of silently forgetting it (see [Context management](#context-management))
- Optional RAG over a folder of markdown notes (`--docs <path>`): indexes the folder with a dedicated embedding model and exposes a `search_docs` tool the model can call on demand
- Optional skills support (`--skills <path>`): loads `SKILL.md` files compatible with the Claude Code / Codex / community skills convention (e.g. [mattpocock/skills](https://github.com/mattpocock/skills)), exposed as a `load_skill` tool the model calls on demand

## Requirements

- Node.js 20.12 or newer
- npm
- Network access to download model files from Hugging Face
- Enough disk space for the selected llamafile model

## Setup

Install dependencies:

```sh
npm install
```

## Run

Start the app:

```sh
npm run dev
```

The first run will:

1. Prompt you to choose a model from the catalog (or "Connect to a server…" to use a remote backend).
2. Download that model into `./models` if it is not already present.
3. Start the llamafile server locally on port `8080`.
4. Open the REPL.

Type a message and press Enter. A spinner shows while the model is thinking, updating to show tool activity (e.g. "Calling search_docs...") if the model uses one along the way. The reply appears in a bordered panel once ready. Type `exit` or press Ctrl+C to quit.

Server logs from llamafile itself are written to `mithril.log`, not the terminal, to keep the chat output clean.

### Using a different backend (Ollama, LM Studio, OpenAI, ...)

**From the picker:** choose "Connect to a server…" at the bottom of the model list. Mithril asks which server (Ollama, LM Studio, OpenAI, OpenRouter, or a custom URL), then the URL, then an API key if needed (masked, kept in memory only, never written to disk), then lets you pick from the models the server reports at `/v1/models`. If the server doesn't list models, you can type a name instead.

**From the command line:** skip the picker entirely by pointing Mithril at a server that is already running:

```sh
# Ollama
npm run dev -- --base-url http://localhost:11434 --model qwen3:8b

# LM Studio
npm run dev -- --base-url http://localhost:1234 --model qwen2.5-coder-7b-instruct

# A hosted provider (key via environment, never a flag)
export MITHRIL_API_KEY=sk-...
npm run dev -- --base-url https://api.openai.com/v1 --model gpt-4.1
```

- `--base-url` accepts the URL with or without a trailing `/v1`.
- `--model` is required with `--base-url`: it's the model name your server expects.
- The API key is read from `MITHRIL_API_KEY` (falling back to `OPENAI_API_KEY`). There is intentionally no `--api-key` flag, since command-line arguments leak into shell history and process listings.
- `MITHRIL_BASE_URL` and `MITHRIL_MODEL` can be used instead of the flags.
- Mithril sends a quick `GET /v1/models` at startup and warns (without exiting) if the server is unreachable or rejects your key.
- The backend must support OpenAI-style tool calling (`tools` / `tool_calls`) for the agent features to work.
- `--docs` still launches a local embedding model for RAG, regardless of which chat backend you use.

### Chatting with your notes (RAG)

Point Mithril at a folder of markdown files to let the model search them on demand:

```sh
npm run dev -- --docs ./notes
```

On first use with a given folder, Mithril will:

1. Download a dedicated embedding model (`mxbai-embed-large-v1`, ~699 MB) into `./models`, if not already present.
2. Launch it as a second local server, separate from your chat model.
3. Chunk each markdown file by `##` heading and embed each chunk.
4. Cache the result as `.mithril-index.json` inside the docs folder — on later runs, only new or edited files are re-embedded.

The model doesn't see your notes automatically; it calls a `search_docs` tool only when it decides your question might be answered by them, and only the retrieved passages are added to the conversation.

### Using skills

Point Mithril at a folder of `SKILL.md` files to let the model load detailed instructions for specific workflows on demand:

```sh
npm run dev -- --skills ./skills
```

Each skill is a `SKILL.md` file with YAML frontmatter and a markdown body:

```markdown
---
name: tdd
description: Test-driven development. Use when implementing features or fixing bugs test-first.
---

# Test-Driven Development

Write a failing test first, then make it pass, then refactor.
```

Skills can be nested under category folders (`skills/engineering/tdd/SKILL.md`) — Mithril discovers `SKILL.md` files recursively, regardless of depth. This is the same convention used by Claude Code, Codex, and the broader community skills ecosystem, so existing skill packs work without modification. For example, to try [mattpocock/skills](https://github.com/mattpocock/skills):

```sh
git clone https://github.com/mattpocock/skills /tmp/matt-skills
npm run dev -- --skills /tmp/matt-skills/skills
```

Mithril doesn't inject every skill's full content into context up front — only a short name/description catalog is listed in the system prompt. The model calls a single `load_skill` tool with a skill's name to pull in its full instructions only when it decides a task matches, keeping unused skills cheap regardless of how many are available.

`--docs` and `--skills` can be combined, and compose onto the same tool list.

## Streaming

Answers are printed token by token as the model generates them, which matters most on slow local models. Tool calls are different: a tool call's arguments are JSON, and a fragment of JSON can't be run. So Mithril collects the whole call and only acts on it once the model has finished sending it. A response that is cut off partway through a tool call (a dropped connection, a crashed server) is reported as a server error and the half-received call is never executed.

Details that matter with small models:

- **Raw tool-call text is hidden.** Some models write a tool call as plain text (`<tool_call>{...}`) before the server converts it. The start of each response is held back for a moment, and if it looks like a tool call it is not printed.
- **Reasoning is not part of the answer.** "Thinking" models that stream their reasoning separately (`reasoning_content`) show a "Reasoning..." status while they think; that text is never added to the conversation.
- **Token usage is still tracked.** Mithril asks the server for usage in the final chunk (`stream_options.include_usage`) so context budgeting stays calibrated. Servers that don't send it stay on the estimate.
- **Servers that ignore streaming work too.** If a server answers with a plain JSON body, the whole answer is shown at once.
- **`--no-stream`** turns streaming off for a backend whose streaming or tool-call support is unreliable. `mithril eval` never streams, so measurements are unaffected.

## Headless mode (`mithril -p`)

`mithril -p "<prompt>"` runs one task with no prompts and exits, for scripts, CI and benchmarking. It talks to a model server that is already running, so it needs `--base-url` and `--model` (or `MITHRIL_BASE_URL` and `MITHRIL_MODEL`); it never opens the model picker.

```sh
mithril -p "Summarize what src/ does" --base-url http://localhost:11434 --model qwen3:4b
git diff | mithril -p "Review this diff for bugs" --base-url ... --model ...
mithril -p "Fix the failing test" --allow-write --allow-command node,npm --timeout 600 --base-url ... --model ...
```

**Read-only by default.** What you don't allow is not even offered to the model, so it doesn't waste steps on tools that can only fail.

- `--allow-write` lets the agent create and edit files in the project.
- `--allow-command node,npm` lets it run those programs. Give program names only, not whole commands. Chaining, pipes, redirection and `cd` are refused, with a message telling the model what to do instead. This is an **accident guard, not a sandbox**: an allowed `node` can still run any script it can run. For untrusted models, run inside a container.
- There is deliberately no "allow everything" flag.
- `MITHRIL_API_KEY` and `OPENAI_API_KEY` are removed from the environment of the commands the agent runs. The model server still gets them.

**Output.** The answer is the only thing on stdout; warnings and `--verbose` tool-call logging go to stderr, so it is safe to pipe. On failure stdout stays empty, so `answer=$(mithril -p ...)` never captures an error message as an answer. With `--output-format json` you get one object instead:

```json
{"ok":true,"result":"...","stop_reason":"answered","model":"qwen3:4b","duration_ms":8120,
 "model_calls":3,"tool_calls":{"total":2,"by_name":{"read_file":2},"outcomes":{"ok":2}},
 "usage":{"prompt_tokens":2310,"completion_tokens":180},"files_changed":[]}
```

On failure it has `"ok":false` and an `"error"` instead of `"result"`. `usage` values are `null` when the server doesn't report them, and `files_changed` lists files the agent successfully wrote or edited.

| Exit code | Meaning |
|---|---|
| 0 | answered |
| 1 | failed (server error, or the request no longer fits the context window) |
| 2 | usage or configuration error; nothing was run |
| 3 | ran out of steps (`--max-steps`, default 15) |
| 124 | timed out (`--timeout <seconds>`; no limit by default) |
| 130 | interrupted (Ctrl+C) |

The prompt can also be piped in: use `-p` with no value, or `-p -`. Other options: `--context`, `--temperature` (use 0 for repeatable runs), `--skills <dir>`, `--verbose`. Run `mithril -p --help` for the full list. Unknown flags are errors rather than being ignored, because nobody is watching a headless run. `--docs` is not supported yet.

## Context management

Small models have small context windows, and coding sessions fill them fast (file reads and command output dominate). Mithril checks the prompt size before **every** model call, including each tool step inside a single turn, and compacts only as much as needed, cheapest measure first:

1. **Trim old tool results.** Output from earlier `read_file`, `run_command` and similar calls is replaced by a one-line stub (`[Earlier read_file src/x.ts result (8000 chars) was removed…]`) that tells the model it can call the tool again. The two newest steps are left alone.
2. **Condense old conversation.** Whole older exchanges are removed and replaced by a short summary appended to the system prompt: what you asked, which files were modified or read, which commands ran and their exit codes, and the model's earlier conclusions. The summary is built mechanically from the history, so it costs no extra model call and doesn't depend on a small model summarizing well. It is capped in size and keeps the newest entries.
3. **Inside a long task**, older steps are trimmed and then condensed the same way. Your latest request and the newest step are never removed.
4. **Last resort:** the newest tool result is truncated (start and end kept).

Any single tool result is also capped as it arrives (a quarter of the prompt budget, at least 2,000 characters). If a request still cannot fit, Mithril stops with an explanation instead of sending an oversized prompt.

**Window size** is resolved in this order:

1. `--context <tokens>` (or `MITHRIL_CONTEXT`). With a local model this also starts the server with `-c <tokens>`, so the server and Mithril agree.
2. For a local model, the size the server reports (`GET /props`), capped at 32,768 tokens.
3. A default: 8,192 tokens for local models, 16,000 for remote backends.

About 20% of the window (512 to 4,096 tokens) is reserved for the model's reply. `/context` shows the window, current usage, and how many compactions have happened this session.

Things to know:

- **Fixed overhead is kept small on purpose.** The system prompt plus the tool definitions use about 850 estimated tokens, paid on every model call (see the [overhead budget test](src/agent/overhead.test.ts)). Windows below about 3,072 tokens leave little room for conversation; Mithril warns at startup if yours is too small and suggests a value. Enabling `--docs` or `--skills` adds a tool, and the skills list is part of that tool's description, so a large skills folder costs context.
- **Token counts are estimated** (about 4 characters per token) and then calibrated against the `usage.prompt_tokens` your server reports, so budgets adapt to the model's actual tokenizer. Servers that don't report usage just stay on the estimate.
- **Ollama:** its OpenAI-compatible endpoint serves the model's configured `num_ctx` (often 2,048 to 4,096 by default), regardless of what Mithril assumes. Set a larger `num_ctx` in Ollama, then pass a matching `--context`.
- The compaction summary is a heuristic. The model is told to re-read files or re-run commands if it needs exact details.

## Evaluating models (`mithril eval`)

`mithril eval` runs coding tasks against a model and reports how many it completes, so claims like "works on a 4B model" can be measured instead of guessed. It uses the same backend startup, system prompt, tools and context management as the chat app.

```sh
# Pick a model interactively (local llamafile or a server), run every task 3 times
npm run dev -- eval --runs 3 --label baseline

# Against a server that is already running
npm run dev -- eval --base-url http://localhost:11434 --model qwen3:8b --runs 3

# Just some tasks, with a fixed temperature
npm run dev -- eval --task fix-off-by-one,rename-across-files --temperature 0.2

# Compare two results files
npm run dev -- eval --compare eval-results/before.json eval-results/after.json
```

**What it measures per run:** pass or fail (graded by a script, not by the model), model calls, tool calls split into *malformed* (unknown tool, unparseable arguments) and *failed* (the tool ran and reported an error), declined commands, tokens when the server reports them, peak prompt size, and time. Failed runs record why (`empty_reply`, `no_changes`, `check_failed`, `wrong_answer`, `max_steps`, `timeout`, `context_limit`, `server_error`) and keep their transcript, so you can read what the model actually did. `empty_reply` means the model's final message was blank, which some "thinking" models do when their output lands in a separate reasoning field. Results are written to `eval-results/` as JSON.

**Refusals explain themselves.** When the eval policy refuses a command, the model is told why and what to do instead ("you are already in the project directory, so do not cd", "use `read_file`, `list_dir`, `find_files` or `search_code`", "run one plain command at a time"). A bare "declined" teaches a model nothing and small models tend to retry the same command, which would measure the harness's rules rather than the model.

Tool errors do the same for the model: `edit_file` failures say which field is which ("`target_content` must be text that is already in the file; the new text belongs in `replacement_content`"), detect swapped fields, and point to `write_file` with `overwrite=true` for whole-file rewrites. An edit whose target and replacement are identical is an error rather than a silent no-op.

**Measuring a change to the prompt or tools.** Run the eval before and after with the same `--runs`, `--temperature` and `--transcripts all`, then `--compare` the two files. Each result records the prompt fingerprint and harness version, so the comparison says whether the prompt, the environment, or both differed. A single run per task cannot show a modest improvement: with 9 tasks, roughly 8 runs each are needed before a jump from 41% to 70% separates from noise.

**Comparing across changes.** Results record a *harness version* (`src/eval/version.ts`) next to the prompt fingerprint. The fingerprint covers the system prompt and tool definitions; the version covers the environment around them, such as how refusals and tool errors are worded. `--compare` warns when two files came from different versions, so an old baseline is never silently compared with a changed environment.

**Long runs are safe to stop.** Results are saved after every run, and a file that isn't finished is marked `"partial": true` (and says so at the top of the summary, and in `--compare`). Press Ctrl+C, or `docker stop` the container, and the run in progress is abandoned, what was measured so far is saved and summarised, and the exit code is 130 (SIGINT) or 143 (SIGTERM). The unfinished run is not counted as a failure. Press Ctrl+C a second time to quit immediately.

**Reading the numbers:** models are not deterministic, and a few runs is a small sample. Summaries show pass counts with a 95% interval, and `--compare` says "within noise" unless the intervals separate. Use `--runs 3` or more, and treat per-task differences from a handful of runs as anecdotes.

**Tasks** live in `eval-tasks/`. Each is a directory with `task.json` (id, title, prompt, optional limits), a `fixture/` project, a `check.mjs` that grades the result, and a reference `solution/`. The check runs outside the project, so the agent can neither see nor edit it. `mithril eval --verify-tasks` proves every task is sound with no model: the untouched fixture must fail its check and the reference solution must pass. Point `--tasks <dir>` at your own directory to add tasks.

**Safety:** eval mode approves file edits automatically and runs the commands the model asks for, inside a temporary copy of each task. Commands are limited to the task's allow-list (default: `node`) and may not contain shell operators. That is an accident guard, not a sandbox: an allowed `node` can still run any script the agent writes, and check scripts execute code the agent produced. For anything beyond a model you trust on your own machine, use the container setup below.

### Running evals in a container

`scripts/eval-docker.sh` runs the eval in a locked-down Docker container. Run the model server (Ollama, LM Studio, a llamafile, ...) outside the container; the container only runs the eval.

```sh
scripts/eval-docker.sh --base-url http://localhost:11434 --model qwen3:8b --runs 3
```

It builds the image the first time, then runs it with a read-only root filesystem, a small `/tmp` tmpfs for scratch projects, all Linux capabilities dropped, no privilege escalation, process, memory and CPU limits, and your own uid (it refuses to run as root). The only host directory mounted is the results directory, `./eval-results` by default. Every argument goes to `mithril eval`, with a few adjustments:

- `--base-url http://localhost:...` is rewritten to `host.docker.internal`, because inside the container `localhost` is the container itself. Your server must then listen on a non-loopback address (for Ollama, `OLLAMA_HOST=0.0.0.0`).
- `--tasks <dir>` is mounted read-only into the container.
- `--out`, `--compare` and `--keep-workdirs` are refused with an explanation. Run `--compare` directly; it only reads files.

Settings are environment variables, so they never clash with eval's own flags: `MITHRIL_EVAL_RESULTS`, `MITHRIL_EVAL_IMAGE`, `MITHRIL_EVAL_MEMORY` (default `1g`), `MITHRIL_EVAL_CPUS` (default `1`), `MITHRIL_EVAL_NETWORK`, `MITHRIL_EVAL_REBUILD=1`, and `MITHRIL_EVAL_DRY_RUN=1`, which prints the exact `docker` command instead of running it.

What this does and does not protect against:

- **Contained:** the agent can't modify the image or reach your files, and runaway or fork-bombing scripts hit the limits.
- **Not contained: your host's ports.** `host.docker.internal` lets the container reach every port on your host, not only the model server. For a stronger setup, run the model server in its own container and put both on a Docker network created with `--internal` (no outside access), then set `MITHRIL_EVAL_NETWORK` and use the server's container name in `--base-url`. With a custom network the script neither rewrites the URL nor adds the host mapping.
- **Not contained: API keys.** If `MITHRIL_API_KEY` or `OPENAI_API_KEY` is set, it is forwarded (by name, so the value never appears on a command line) and code the model writes could read it. A hosted model also needs internet access. Use a throwaway key with a spend limit.
- **Containers share your host's kernel.** For models you really don't trust, use a throwaway VM.

The container setup has been tested with a fake `docker` (the command line, build and run flow, exit codes, and that secrets never appear in output), but not yet against a real Docker daemon.

## Model catalog

The picker's model list is not hardcoded. On startup Mithril asks the Hugging Face API for the file listing of [`mozilla-ai/llamafile_0.10`](https://huggingface.co/mozilla-ai/llamafile_0.10), keeps the chat-capable `.llamafile` files (embedding models are excluded), and reads their real sizes from the listing. When the repo adds or removes a model, the picker follows.

Resolution order, so the picker always has something to show:

1. A cache younger than 24 hours (`models/.catalog-cache.json`)
2. The live listing (then cached)
3. A stale cache, if the network is down
4. The curated list in `src/models/catalog.ts`, which also supplies friendly names and license info for models we've tried. Models it doesn't know about get a name derived from the filename (`Qwen3.5-4B-Q5_K_S.llamafile` becomes "Qwen3.5 4B (Q5_K_S)") and no license hint.

Any `.llamafile` already sitting in `models/` is always listed (marked "downloaded"), even if upstream has since removed it. The picker tells you when it is showing a cached or built-in list instead of a fresh one.

Models discovered this way haven't necessarily been tested with Mithril. The curated entries are the ones that have.

## How it works

- `src/index.ts` — app entry point; wires everything together
- `src/config.ts` — backend selection (local llamafile vs. remote OpenAI-compatible server) and flag/env parsing
- `src/types.ts` — shared types used across the project
- `src/repl.ts` — the interactive chat loop
- `src/headless.ts` — `mithril -p`: argument parsing, permissions, JSON output and exit codes
- `src/client/llama-client.ts` — HTTP client for chat (including server-reported token usage), streaming (with tool-call assembly), and embeddings
- `src/llamafile/manager.ts` — launches and monitors a llamafile process
- `src/models/` — model acquisition: `catalog.ts` (curated fallback list), `catalog-source.ts` (live discovery, caching, fallback), `remote-setup.ts` (the "Connect to a server…" flow), `embedding-model.ts`, `downloader.ts`, `onboarding.ts` (picker flow), `paths.ts`
- `src/agent/` — `agent-loop.ts` (tool-calling loop), `tools.ts` (local tools, including `read_file`), `context-manager.ts` (keeps the prompt within the context window), `context.ts` (token estimation and the older simple trimmer), `stream-printer.ts` (hides raw tool-call text while streaming)
- `src/backend.ts` — starts whichever chat backend was requested (shared by the chat app and `mithril eval`)
- `src/eval/` — the evaluation harness (`cli.ts`, `runner.ts`, `tasks.ts`, `report.ts`, `policy.ts`, `stats.ts`); `eval-tasks/` holds the built-in tasks
- `src/context-window.ts` — `--context` parsing, detecting the server's window, and defaults
- `src/rag/` — `chunker.ts`, `indexer.ts`, `retriever.ts`, `rag-tool.ts` (the `search_docs` tool, wired in only when `--docs` is passed)
- `src/skills/` — `loader.ts` (discovers and parses `SKILL.md` files), `skill-tool.ts` (the `load_skill` tool, wired in only when `--skills` is passed)

## Local model directory

Downloaded models are stored under:

```text
./models/
```

If a model file already exists there, Mithril skips the download step for that model. Downloads are written to a temporary `.part` file first and only renamed into place once complete, so a partially-downloaded file is never mistaken for a finished one.

## API behavior

The client sends requests to:

```text
http://localhost:8080/v1/chat/completions
```

The REPL streams by default (`stream: true`, with usage requested in the final chunk). Each model call is accumulated into one complete message before the loop decides whether to run a tool or show an answer, so the loop sees the same result either way. `--no-stream` and `mithril eval` use plain non-streaming requests.

## Project status

- TypeScript is configured with Node types enabled; `npm run build` type-checks the project without emitting output.
- `npm test` runs Node's built-in test runner through `tsx`; new test files must be added to the list in `package.json`.
- This is a local learning project rather than a hardened production application. File tools are sandboxed to the project directory, and `write_file`, `edit_file` and `run_command` require your confirmation each time. `run_command` executes through your shell with your full environment, so the confirmation prompt is the only safeguard: read commands before approving them.

## Development notes

The repository includes a generated `package-lock.json`, which helps keep installs reproducible.
