# Mithril

Mithril is a small TypeScript command-line app that downloads a local llamafile model, starts it as a local OpenAI-compatible chat server, and provides a tool-using REPL for chatting with that model.

The app is designed for a local-first workflow: choose a model from a catalog, download it if it is not already present, launch the model server, and open an agent loop without needing a separate hosted AI service.

## Features

- ASCII-art banner on launch, followed by interactive model selection (`@clack/prompts`)
- Automatic download of selected llamafile models into a local `models/` directory, with atomic writes so an interrupted download can't be mistaken for a complete one
- Launches the model with `--server --port 8080 --no-webui --jinja`
- Polls the server health endpoint until it is ready
- Sends chat requests to the OpenAI-compatible `/v1/chat/completions` endpoint
- Runs a tool-calling agent loop (non-streaming): the model can call local tools, see the results, and respond based on them
- Includes a local `read_file` tool, sandboxed to the project directory
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

1. Prompt you to choose a model from the built-in catalog.
2. Download that model into `./models` if it is not already present.
3. Start the llamafile server locally on port `8080`.
4. Open the REPL.

Type a message and press Enter. A spinner shows while the model is thinking, updating to show tool activity (e.g. "Calling search_docs...") if the model uses one along the way. The reply appears in a bordered panel once ready. Type `exit` or press Ctrl+C to quit.

Server logs from llamafile itself are written to `mithril.log`, not the terminal, to keep the chat output clean.

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

## How it works

- `src/index.ts` — app entry point; wires everything together
- `src/types.ts` — shared types used across the project
- `src/repl.ts` — the interactive chat loop
- `src/client/llama-client.ts` — HTTP client for chat, streaming, and embeddings
- `src/llamafile/manager.ts` — launches and monitors a llamafile process
- `src/models/` — model acquisition: `catalog.ts` (chat model list), `embedding-model.ts`, `downloader.ts`, `onboarding.ts` (picker flow), `paths.ts`
- `src/agent/` — `agent-loop.ts` (tool-calling loop), `tools.ts` (local tools, including `read_file`)
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
- `npm test` runs Node's built-in test runner (`node --test`); no tests are written yet.
- This is a local learning project rather than a hardened production application. The `read_file` tool is sandboxed to the project directory, but no other tools have been added yet, and there is no confirmation step before a tool runs.

## Development notes

The repository includes a generated `package-lock.json`, which helps keep installs reproducible.
