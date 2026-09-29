import { createWriteStream } from "node:fs";
import { chmod } from "node:fs/promises";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

export async function downloadFile(
  url: string,
  destPath: string,
  onProgress: (percent: number) => void
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download: ${response.status}`);
  }

  const totalBytes = Number(response.headers.get("content-length") ?? 0);
  let downloadedBytes = 0;

  const fileStream = createWriteStream(destPath);

  // fetch() gives us a web-standard ReadableStream; Readable.fromWeb()
  // converts it into a Node stream so we can pipe it to a file.
  const nodeStream = Readable.fromWeb(response.body as any);

  nodeStream.on("data", (chunk: Buffer) => {
    downloadedBytes += chunk.length;
    if (totalBytes > 0) onProgress(Math.round((downloadedBytes / totalBytes) * 100));
  });

  nodeStream.pipe(fileStream);

  // Waits until the write stream actually finishes (or rejects on error).
  await finished(fileStream);

  // Executable permission — required on macOS/Linux before running the file.
  await chmod(destPath, 0o755);
}