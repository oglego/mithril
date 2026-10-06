import { spawn } from "node:child_process";

export interface CommandOptions {
  timeoutSeconds?: number | undefined;
  maxOutputChars?: number | undefined;
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export async function executeCommand(
  command: string,
  cwd: string,
  options: CommandOptions = {}
): Promise<CommandResult> {
  const timeoutMs = Math.min(Math.max(options.timeoutSeconds ?? 30, 1), 120) * 1000;
  const maxOutputChars = options.maxOutputChars ?? 4000;

  const startTime = Date.now();
  let timedOut = false;

  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? process.env.COMSPEC || "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];

    const child = spawn(shell, shellArgs, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";

    const append = (data: Buffer) => {
      buffer += data.toString("utf-8");
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolve({
        command,
        exitCode: 1,
        output: `Failed to spawn command: ${err.message}`,
        durationMs,
        timedOut: false,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      let output = buffer.trim();
      if (timedOut) {
        output += `\n\n[Command timed out after ${timeoutMs / 1000} seconds and was terminated.]`;
      }

      if (output.length > maxOutputChars) {
        const totalChars = output.length;
        const tail = output.slice(output.length - maxOutputChars);
        output = `[Output truncated: showing last ${maxOutputChars} characters of ${totalChars} total characters]\n\n${tail}`;
      }

      resolve({
        command,
        exitCode: timedOut ? 124 : (code ?? 0),
        output: output.length > 0 ? output : "(No output)",
        durationMs,
        timedOut,
      });
    });
  });
}
