export interface Chunk {
  heading: string;
  content: string;
}

// Sections longer than this get further split into fixed-size pieces, so
// one huge heading-less section doesn't become one unfocused chunk that's
// expensive to embed and vague to retrieve.
export const MAX_CHUNK_CHARS = 2000;

// Splits oversized section content along natural text boundaries (paragraphs,
// line breaks, sentence/word breaks) to preserve semantic coherence and
// avoid splitting in the middle of words or code blocks.
function splitOversizedContent(content: string, maxChars: number, overlapChars = 150): string[] {
  const result: string[] = [];
  let start = 0;

  while (start < content.length) {
    if (content.length - start <= maxChars) {
      const piece = content.slice(start).trim();
      if (piece.length > 0) result.push(piece);
      break;
    }

    const targetEnd = start + maxChars;
    const searchStart = Math.max(start + 1, targetEnd - Math.max(overlapChars, 100));

    // Try finding paragraph break first, then line break, then word boundary
    let splitPos = content.lastIndexOf("\n\n", targetEnd);
    if (splitPos < searchStart) {
      splitPos = content.lastIndexOf("\n", targetEnd);
    }
    if (splitPos < searchStart) {
      splitPos = content.lastIndexOf(" ", targetEnd);
    }

    // Fall back to hard slice if text is continuous with no boundaries (e.g. unbroken token)
    if (splitPos <= start || splitPos > targetEnd) {
      splitPos = targetEnd;
    }

    const chunkText = content.slice(start, splitPos).trim();
    if (chunkText.length > 0) {
      result.push(chunkText);
    }

    if (splitPos === targetEnd) {
      start = splitPos;
    } else {
      const nextCandidate = Math.max(start + 1, splitPos - overlapChars);
      const nextWord = content.indexOf(" ", nextCandidate);
      if (nextWord !== -1 && nextWord < splitPos) {
        start = nextWord + 1;
      } else {
        start = splitPos;
      }
    }
  }

  return result;
}

// Splits markdown text into chunks along "## " heading boundaries — a
// natural, human-authored structure that usually lines up with distinct
// topics, which makes for better retrieval than arbitrary fixed windows.
export function chunkMarkdown(text: string): Chunk[] {
  const lines = text.split("\n");
  const sections: Chunk[] = [];

  let currentHeading = "Introduction";
  let currentLines: string[] = [];

  const flush = () => {
    const content = currentLines.join("\n").trim();
    if (content.length > 0) {
      sections.push({ heading: currentHeading, content });
    }
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      currentHeading = line.replace(/^##\s+/, "").trim();
    } else {
      currentLines.push(line);
    }
  }
  flush();

  // Further split any section still over the size cap.
  const chunks: Chunk[] = [];
  for (const section of sections) {
    if (section.content.length <= MAX_CHUNK_CHARS) {
      chunks.push(section);
      continue;
    }

    const splitPieces = splitOversizedContent(section.content, MAX_CHUNK_CHARS);
    for (const piece of splitPieces) {
      chunks.push({
        heading: section.heading,
        content: piece,
      });
    }
  }

  return chunks;
}

