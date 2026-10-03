import { createWriteStream } from "node:fs";
import { chmod, rename, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

export async function downloadFile(
  url: string,
  destPath: string,
  onProgress: (percent: number) => void
): Promise<void> {
  // Download into a ".part" file alongside the real destination. Only a
  // fully-verified download gets promoted to destPath, so onboarding's
  // existsSync(destPath) check can never see a half-written file.
  const tempPath = `${destPath}.part`;

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download: ${response.status}`);
  }

  const totalBytes = Number(response.headers.get("content-length") ?? 0);
  let downloadedBytes = 0;

  const fileStream = createWriteStream(tempPath);

  // fetch() gives us a web-standard ReadableStream; Readable.fromWeb()
  // converts it into a Node stream so we can pipe it to a file.
  const nodeStream = Readable.fromWeb(response.body as any);

  nodeStream.on("data", (chunk: Buffer) => {
    downloadedBytes += chunk.length;
    if (totalBytes > 0) onProgress(Math.round((downloadedBytes / totalBytes) * 100));
  });

  nodeStream.pipe(fileStream);

  try {
    // Waits until the write stream actually finishes (or rejects on error).
    await finished(fileStream);

    if (totalBytes > 0 && downloadedBytes !== totalBytes) {
      throw new Error(`Incomplete download: got ${downloadedBytes} of ${totalBytes} bytes.`);
    }

    // rename() on the same filesystem is atomic: destPath either fully
    // exists with complete content, or doesn't exist at all — never a
    // half-written file sitting at the final name.
    await rename(tempPath, destPath);

    // Executable permission — required on macOS/Linux before running the file.
    await chmod(destPath, 0o755);
  } catch (err) {
    // Clean up the partial file so a retry doesn't get confused by it.
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}