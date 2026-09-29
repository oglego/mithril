import { spawn, type ChildProcess } from "node:child_process";

export interface LlamafileConfig {
  binaryPath: string; // path to your .llamafile executable
  port: number;
}

export class LlamafileManager {
  private process: ChildProcess | null = null;

  constructor(private config: LlamafileConfig) {}

  // Starts the llamafile process and waits until its server responds,
  // instead of just assuming it's ready.
  async start(): Promise<void> {
    console.log(`Starting llamafile from ${this.config.binaryPath}...`);

    this.process = spawn(
      this.config.binaryPath,
      ["--server", "--port", String(this.config.port), "--nobrowser"],
      { stdio: ["ignore", "pipe", "pipe"] } // pipe stdout/stderr so we can read them
    );

    // These are event listeners: functions that run when something happens
    // on the child process, whenever it happens.
    this.process.stderr?.on("data", (chunk: Buffer) => {
      // llamafile logs startup info to stderr; useful while debugging.
      process.stderr.write(chunk);
    });

    this.process.on("exit", (code) => {
      console.log(`llamafile exited with code ${code}`);
      this.process = null;
    });

    await this.waitUntilReady();
  }

  // Polls the health endpoint every 500ms until the server responds,
  // or gives up after ~30 seconds.
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
        // Server isn't listening yet — expected during startup, ignore and retry.
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error("llamafile did not become ready in time.");
  }

  // Kills the process. We call this on shutdown so we don't leave
  // an orphaned llamafile running in the background.
  stop(): void {
    this.process?.kill();
    this.process = null;
  }
}