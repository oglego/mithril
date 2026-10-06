export interface ReplacementResult {
  success: boolean;
  content?: string;
  error?: string;
  matchType?: "exact" | "whitespace_normalized";
}

export function applyReplacement(
  original: string,
  target: string,
  replacement: string,
  allowMultiple = false
): ReplacementResult {
  if (target.length === 0) {
    return { success: false, error: 'target_content cannot be empty.' };
  }

  // --- Level 1: Exact match ---
  let count = 0;
  let pos = original.indexOf(target);
  while (pos !== -1) {
    count++;
    pos = original.indexOf(target, pos + target.length);
  }

  if (count === 1) {
    const idx = original.indexOf(target);
    const updated = original.slice(0, idx) + replacement + original.slice(idx + target.length);
    return { success: true, content: updated, matchType: "exact" };
  }

  if (count > 1) {
    if (allowMultiple) {
      const updated = original.split(target).join(replacement);
      return { success: true, content: updated, matchType: "exact" };
    }
    return {
      success: false,
      error: `target_content was found ${count} times in the file. Please provide more surrounding lines to uniquely identify the section to replace.`,
    };
  }

  // --- Level 2: Whitespace / Indentation Tolerant Matching ---
  // Local models frequently produce small differences in indentation or line endings.
  const origLines = original.split(/\r?\n/);
  const targetLines = target.split(/\r?\n/);

  if (targetLines.length > origLines.length) {
    return {
      success: false,
      error: "target_content has more lines than the target file.",
    };
  }

  // Try matching with normalized lines (trimmed of leading and trailing whitespace)
  const normOrig = origLines.map((l) => l.trim());
  const normTarget = targetLines.map((l) => l.trim());

  const matches: number[] = [];
  for (let i = 0; i <= normOrig.length - normTarget.length; i++) {
    let match = true;
    for (let j = 0; j < normTarget.length; j++) {
      if (normOrig[i + j] !== normTarget[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      matches.push(i);
    }
  }

  if (matches.length === 1) {
    const startLine = matches[0]!;
    const endLine = startLine + targetLines.length;

    // Calculate character offsets in the original text
    // We replace from the beginning of startLine up to the end of endLine - 1
    const beforeLines = origLines.slice(0, startLine);
    const afterLines = origLines.slice(endLine);

    const beforePart = beforeLines.length > 0 ? beforeLines.join("\n") + "\n" : "";
    const afterPart = afterLines.length > 0 ? "\n" + afterLines.join("\n") : "";

    const updated = beforePart + replacement + afterPart;
    return { success: true, content: updated, matchType: "whitespace_normalized" };
  }

  if (matches.length > 1) {
    return {
      success: false,
      error: `target_content matched ${matches.length} locations under whitespace-tolerant matching. Please provide more surrounding context.`,
    };
  }

  return {
    success: false,
    error: "target_content not found in file. Use read_file to check the exact lines and formatting.",
  };
}

export interface FileBackup {
  filePath: string;
  relativePath: string;
  content: string;
  timestamp: number;
}

class BackupRegistry {
  private history: FileBackup[] = [];

  record(filePath: string, relativePath: string, content: string): void {
    this.history.push({ filePath, relativePath, content, timestamp: Date.now() });
  }

  pop(): FileBackup | undefined {
    return this.history.pop();
  }

  peek(): FileBackup | undefined {
    return this.history[this.history.length - 1];
  }

  list(): FileBackup[] {
    return [...this.history];
  }

  clear(): void {
    this.history = [];
  }
}

export const backupRegistry = new BackupRegistry();
