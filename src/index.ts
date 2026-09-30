import { runRepl } from "./repl.js";
import { LlamafileManager } from "./llamafile-manager.js";
import { selectAndPrepareModel } from "./onboarding.js";

const { binaryPath, modelId } = await selectAndPrepareModel();

const llamafile = new LlamafileManager({ binaryPath, port: 8080 });

process.on("SIGINT", () => {
  llamafile.stop();
  process.exit(0);
});

await llamafile.start();

await runRepl({
  baseUrl: "http://localhost:8080",
  model: modelId,
});