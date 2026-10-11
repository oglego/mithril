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
- Runs a tool-calling agent loop (non-streaming): the model can call local tools, see the results, and respond based on them
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

- **Fixed overhead is substantial.** The system prompt plus the tool definitions currently use about 1,600 tokens. Windows below about 4,096 tokens leave little room for conversation; Mithril warns at startup if yours is too small and suggests a value.
- **Token counts are estimated** (about 4 characters per token) and then calibrated against the `usage.prompt_tokens` your server reports, so budgets adapt to the model's actual tokenizer. Servers that don't report usage just stay on the estimate.
- **Ollama:** its OpenAI-compatible endpoint serves the model's configured `num_ctx` (often 2,048 to 4,096 by default), regardless of what Mithril assumes. Set a larger `num_ctx` in Ollama, then pass a matching `--context`.
- The compaction summary is a heuristic. The model is told to re-read files or re-run commands if it needs exact details.

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
- `src/client/llama-client.ts` — HTTP client for chat (including server-reported token usage), streaming, and embeddings
- `src/llamafile/manager.ts` — launches and monitors a llamafile process
- `src/models/` — model acquisition: `catalog.ts` (curated fallback list), `catalog-source.ts` (live discovery, caching, fallback), `remote-setup.ts` (the "Connect to a server…" flow), `embedding-model.ts`, `downloader.ts`, `onboarding.ts` (picker flow), `paths.ts`
- `src/agent/` — `agent-loop.ts` (tool-calling loop), `tools.ts` (local tools, including `read_file`), `context-manager.ts` (keeps the prompt within the context window), `context.ts` (token estimation and the older simple trimmer)
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

The REPL currently uses non-streaming requests, since tool-calling responses are validated and parsed as a whole before deciding whether to run a tool or show an answer. A separate streaming code path (`chatStream` in `src/client/llama-client.ts`) exists and is used for straightforward chat, but isn't yet wired into the tool-calling loop.

## Project status

- TypeScript is configured with Node types enabled; `npm run build` type-checks the project without emitting output.
- `npm test` runs Node's built-in test runner through `tsx`; new test files must be added to the list in `package.json`.
- This is a local learning project rather than a hardened production application. File tools are sandboxed to the project directory, and `write_file`, `edit_file` and `run_command` require your confirmation each time. `run_command` executes through your shell with your full environment, so the confirmation prompt is the only safeguard: read commands before approving them.

## Development notes

The repository includes a generated `package-lock.json`, which helps keep installs reproducible.
