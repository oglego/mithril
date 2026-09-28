# Mithril

Mithril is a small TypeScript command-line chat client for a local llama server. It sends conversation history to an OpenAI-compatible `/v1/chat/completions` endpoint and prints streamed responses as they arrive.

## Requirements

- Node.js 18 or newer
- npm
- A local llama server exposing an OpenAI-compatible chat completions endpoint

## Setup

Install the dependencies:

```sh
npm install
```

Start the llama server and make sure it is listening at the URL configured in `src/index.ts`. The default configuration expects:

- Base URL: `http://localhost:8080`
- Model: `gemma-4-E2B-it-qat-UD-Q4_K_XL`

## Run

Start the REPL with:

```sh
npm run dev
```

Type a message at the `you>` prompt. Responses are streamed at the `model>` prompt. Type `exit` to quit.

## Configuration

Change the server URL or model in `src/index.ts`:

```ts
runRepl({
  baseUrl: "http://localhost:8080",
  model: "your-model-name",
});
```

The client sends requests to `${baseUrl}/v1/chat/completions` with streaming enabled.

## Project Structure

- `src/index.ts` - application entry point and local server configuration
- `src/repl.ts` - interactive command-line loop and conversation history
- `src/llama-client.ts` - streaming HTTP client
- `src/types.ts` - chat and streaming response types

## Development

TypeScript configuration is provided in `tsconfig.json`. The repository includes the generated `package-lock.json` for reproducible npm installs.

The test script is currently a placeholder and does not run automated tests yet.
