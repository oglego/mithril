export interface DiffLine {
  type: "add" | "remove" | "keep";
  text: string;
}

export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.length === 0 ? [] : oldText.split(/\r?\n/);
  const newLines = newText.length === 0 ? [] : newText.split(/\r?\n/);

  const n = oldLines.length;
  const m = newLines.length;

  // Build standard Longest Common Subsequence (LCS) matrix
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (oldLines[i] === newLines[j]) {
        dp[i + 1]![j + 1] = dp[i]![j]! + 1;
      } else {
        dp[i + 1]![j + 1] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  // Backtrack to build the diff list
  const result: DiffLine[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "keep", text: oldLines[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push({ type: "add", text: newLines[j - 1]! });
      j--;
    } else if (i > 0) {
      result.push({ type: "remove", text: oldLines[i - 1]! });
      i--;
    }
  }

  result.reverse();
  return result;
}

export function formatUnifiedDiff(
  filePath: string,
  oldText: string,
  newText: string,
  options: { colorize?: boolean; contextLines?: number } = {}
): string {
  const { colorize = false, contextLines = 3 } = options;
  const diff = computeLineDiff(oldText, newText);

  // Check if there are any actual changes
  const hasChanges = diff.some((d) => d.type !== "keep");
  if (!hasChanges) {
    return "(No changes)";
  }

  // ANSI escape codes
  const red = colorize ? "\x1b[31m" : "";
  const green = colorize ? "\x1b[32m" : "";
  const cyan = colorize ? "\x1b[36m" : "";
  const reset = colorize ? "\x1b[0m" : "";

  const header = `${cyan}--- a/${filePath}\n+++ b/${filePath}${reset}`;

  // Find ranges of changes with surrounding context lines
  const changeIndices: number[] = [];
  diff.forEach((d, idx) => {
    if (d.type !== "keep") changeIndices.push(idx);
  });

  if (changeIndices.length === 0) return "(No changes)";

  const linesToShow = new Set<number>();
  for (const idx of changeIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(diff.length - 1, idx + contextLines);
    for (let k = start; k <= end; k++) {
      linesToShow.add(k);
    }
  }

  const output: string[] = [header];
  let lastIndex = -1;

  for (let idx = 0; idx < diff.length; idx++) {
    if (!linesToShow.has(idx)) continue;

    if (lastIndex !== -1 && idx > lastIndex + 1) {
      output.push(`${cyan}@@ ... @@${reset}`);
    }
    lastIndex = idx;

    const line = diff[idx]!;
    if (line.type === "add") {
      output.push(`${green}+ ${line.text}${reset}`);
    } else if (line.type === "remove") {
      output.push(`${red}- ${line.text}${reset}`);
    } else {
      output.push(`  ${line.text}`);
    }
  }

  return output.join("\n");
}
