export interface Chunk {
  heading: string;
  content: string;
}

// Sections longer than this get further split into fixed-size pieces, so
// one huge heading-less section doesn't become one unfocused chunk that's
// expensive to embed and vague to retrieve.
export const MAX_CHUNK_CHARS = 2000;

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

    for (let i = 0; i < section.content.length; i += MAX_CHUNK_CHARS) {
      chunks.push({
        heading: section.heading,
        content: section.content.slice(i, i + MAX_CHUNK_CHARS),
      });
    }
  }

  return chunks;
}
