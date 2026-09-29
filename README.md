# Mithril

Mithril is a small TypeScript command-line app that downloads a local Llamafile model, starts it as a local OpenAI-compatible chat server, and then provides a REPL interface for chatting with that model.

The app is designed for a local-first workflow: choose a model from a catalog, download it if it is not already present, launch the model server, and open a chat loop without needing a separate hosted AI service.

## Features

- Interactive model selection at startup
- Automatic download of selected Llamafile models into a local `models/` directory
- Launches the model with `--server --port 8080 --no-webui --jinja`
- Polls the server health endpoint until it is ready
- Sends chat requests to the OpenAI-compatible `/v1/chat/completions` endpoint
- Streams responses back to the terminal
- Includes a simple tool-calling loop with a local `read_file` tool

## Requirements

- Node.js 18 or newer
- npm
- Network access to download model files from Hugging Face
- Enough disk space for the selected Llamafile model

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

At the `you>` prompt, type a message and press Enter. The model response will be printed at the `model>` prompt. Type `exit` to quit.

## How it works

The application flow is:

- `src/index.ts`: app entry point
- `src/onboarding.ts`: model selection and download workflow
- `src/llamafile-manager.ts`: launches and manages the llamafile process
- `src/repl.ts`: interactive chat loop
- `src/llama-client.ts`: HTTP client for `/v1/chat/completions`
- `src/agent-loop.ts`: handles assistant tool calls and tool-result feedback
- `src/tools.ts`: exposes local tools to the model, including `read_file`
- `src/models.ts`: catalog of downloadable model URLs and metadata

## Local model directory

Downloaded models are stored under:

```text
./models/
```

If a model file already exists there, Mithril skips the download step for that model.

## API behavior

The client sends requests to:

```text
http://localhost:8080/v1/chat/completions
```

The app currently expects an OpenAI-compatible server and uses streaming responses when available.

## Project status

- TypeScript configuration is present in `tsconfig.json`.
- The project has no automated test suite yet.
- The `npm test` script is still a placeholder and exits with an error by design.
- This is a local prototype project rather than a hardened production application.

## Development notes

The repository includes a generated `package-lock.json`, which helps keep installs reproducible. A future improvement would be to add a real test runner and build validation for CI use.
