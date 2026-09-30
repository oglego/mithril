# Mithril

Mithril is a small TypeScript command-line app that downloads a local llamafile model, starts it as a local OpenAI-compatible chat server, and provides a tool-using REPL for chatting with that model.

The app is designed for a local-first workflow: choose a model from a catalog, download it if it is not already present, launch the model server, and open an agent loop without needing a separate hosted AI service.

## Features

- Interactive model selection at startup (`@clack/prompts`)
- Automatic download of selected llamafile models into a local `models/` directory, with atomic writes so an interrupted download can't be mistaken for a complete one
- Launches the model with `--server --port 8080 --no-webui --jinja`
- Polls the server health endpoint until it is ready
- Sends chat requests to the OpenAI-compatible `/v1/chat/completions` endpoint
- Runs a tool-calling agent loop (non-streaming): the model can call local tools, see the results, and respond based on them
- Includes a local `read_file` tool, sandboxed to the project directory

## Requirements

- Node.js 18 or newer
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

At the `you>` prompt, type a message and press Enter. The model's response is printed at the `model>` prompt — if the model calls a tool (e.g. `read_file`) along the way, that happens automatically before the final answer is shown. Type `exit` to quit.

Server logs from llamafile itself are written to `mithril.log`, not the terminal, to keep the chat output clean.

## How it works

- `src/index.ts` — app entry point; wires everything together
- `src/onboarding.ts` — model selection and download workflow
- `src/models.ts` — catalog of downloadable model URLs and metadata
- `src/downloader.ts` — streaming download with progress reporting and atomic writes
- `src/llamafile-manager.ts` — launches and monitors the llamafile process
- `src/llama-client.ts` — HTTP client for `/v1/chat/completions` (both streaming and non-streaming)
- `src/agent-loop.ts` — runs the tool-calling loop: sends the conversation, executes any requested tools, feeds results back, repeats until a plain-text answer
- `src/tools.ts` — local tools exposed to the model, including `read_file`
- `src/repl.ts` — the interactive chat loop

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

The REPL currently uses non-streaming requests, since tool-calling responses are validated and parsed as a whole before deciding whether to run a tool or show an answer. A separate streaming code path (`chatStream` in `src/llama-client.ts`) exists and is used for straightforward chat, but isn't yet wired into the tool-calling loop.

## Project status

- TypeScript is configured with Node types enabled; `npm run build` type-checks the project without emitting output.
- `npm test` runs Node's built-in test runner (`node --test`); no tests are written yet.
- This is a local learning project rather than a hardened production application. The `read_file` tool is sandboxed to the project directory, but no other tools have been added yet, and there is no confirmation step before a tool runs.

## Development notes

The repository includes a generated `package-lock.json`, which helps keep installs reproducible.
