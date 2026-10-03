import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import net from "node:net";

export interface LlamafileConfig {
  binaryPath: string;
  port: number;
  logPath?: string; // where to send llamafile's own logs
  // Process-specific flags, e.g. ["--jinja", "--no-webui"]. Different
  // llamafile binaries bundle different llama.cpp server versions and can
  // accept different flag names (older builds use --nobrowser, newer ones
  // --no-webui) — there is no flag safe to assume across every binary, so
  // nothing is hardcoded here; each caller supplies exactly what its binary needs.
  extraArgs?: string[];
  // A short label used in log output, e.g. "chat model" or "embedding model",
  // so when two LlamafileManager instances run side by side you can tell
  // their console output apart.
  name?: string;
  // Called with human-readable status updates ("Starting...", "ready.",
  // etc). This module stays UI-agnostic — it doesn't know about clack or
  // any particular styling — and just hands status strings to whatever the
  // caller wants to do with them. Defaults to plain console.log.
  onStatus?: (message: string) => void;
}

// Checks whether a port is free by actually trying to briefly bind to it.
// More reliable than probing the HTTP health endpoint, because a stale
// process left over from a previous (possibly crashed) run can answer
// /health perfectly well — it just isn't the process this instance is
// about to spawn, which is exactly the bug this function exists to catch.
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

export class LlamafileManager {
  private process: ChildProcess | null = null;
  private logStream: WriteStream | null = null;
  private lastExitCode: number | null = null;

  constructor(private config: LlamafileConfig) {}

  private get label(): string {
    return this.config.name ?? "llamafile";
  }

  private status(message: string): void {
    (this.config.onStatus ?? console.log)(message);
  }

  async start(): Promise<void> {
    const port = this.config.port;

    // Fail fast and clearly if something is already listening on this port,
    // instead of letting the new process lose a bind race, or worse, letting
    // waitUntilReady mistake someone else's server for ours.
    const free = await isPortFree(port);
    if (!free) {
      throw new Error(
        `Port ${port} is already in use — likely a leftover llamafile process from ` +
          `a previous run. Run "lsof -i :${port}" to find it, kill it, and try again.`
      );
    }

    this.status(`Starting ${this.label} from ${this.config.binaryPath}...`);

    const logPath = this.config.logPath ?? "./mithril.log";
    this.logStream = createWriteStream(logPath, { flags: "a" });

    this.process = spawn(
      "sh",
      [
        this.config.binaryPath,
        "--server",
        "--port",
        String(port),
        ...(this.config.extraArgs ?? []),
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    this.process.stdout?.pipe(this.logStream);
    this.process.stderr?.pipe(this.logStream);

    this.process.on("exit", (code) => {
      this.status(`${this.label} exited with code ${code}`);
      this.lastExitCode = code;
      this.process = null;
    });

    await this.waitUntilReady();
    this.status(`(${this.label} logs are being written to ${logPath})`);
  }

  private async waitUntilReady(): Promise<void> {
    const maxAttempts = 60;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // If the process has already died, stop waiting immediately instead
      // of polling for the full ~30s timeout — the failure already happened,
      // and the real reason is in the log file we just pointed at.
      if (!this.process) {
        const logPath = this.config.logPath ?? "./mithril.log";
        throw new Error(
          `${this.label} exited (code ${this.lastExitCode}) before becoming ready. ` +
            `Check ${logPath} for details.`
        );
      }

      try {
        const response = await fetch(`http://localhost:${this.config.port}/health`);
        if (response.ok) {
          this.status(`${this.label} is ready.`);
          return;
        }
      } catch {
        // not listening yet, retry
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`${this.label} did not become ready in time.`);
  }

  stop(): void {
    this.process?.kill();
    this.process = null;
    this.logStream?.end(); // flush and close the file cleanly
  }
}
