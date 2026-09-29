import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";

export interface LlamafileConfig {
  binaryPath: string;
  port: number;
  logPath?: string; // where to send llamafile's own logs
}

export class LlamafileManager {
  private process: ChildProcess | null = null;
  private logStream: WriteStream | null = null;

  constructor(private config: LlamafileConfig) {}

  async start(): Promise<void> {
    console.log(`Starting llamafile from ${this.config.binaryPath}...`);

    // Open (or create) a log file, appending rather than overwriting.
    const logPath = this.config.logPath ?? "./mithril.log";
    this.logStream = createWriteStream(logPath, { flags: "a" });

    this.process = spawn(
      "sh",
      [this.config.binaryPath, "--server", "--port", String(this.config.port), "--no-webui", "--jinja"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    // Pipe llamafile's stdout/stderr straight into the log file instead
    // of the terminal. .pipe() connects one stream's output to another's input.
    this.process.stdout?.pipe(this.logStream);
    this.process.stderr?.pipe(this.logStream);

    this.process.on("exit", (code) => {
      console.log(`llamafile exited with code ${code}`);
      this.process = null;
    });

    await this.waitUntilReady();
    console.log(`(llamafile logs are being written to ${logPath})`);
  }

  private async waitUntilReady(): Promise<void> {
    const maxAttempts = 60;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(`http://localhost:${this.config.port}/health`);
        if (response.ok) {
          console.log("llamafile is ready.");
          return;
        }
      } catch {
        // not listening yet, retry
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("llamafile did not become ready in time.");
  }

  stop(): void {
    this.process?.kill();
    this.process = null;
    this.logStream?.end(); // flush and close the file cleanly
  }
}