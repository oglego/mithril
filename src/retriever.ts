import type { IndexedChunk } from "./indexer.js";

// Measures how similar two vectors' directions are (1 = identical, 0 =
// unrelated, -1 = opposite), independent of their magnitude. Standard
// similarity measure for comparing embeddings.
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Scores every chunk against the query and returns the top K. A brute-force
// scan like this is plenty fast for hundreds to low-thousands of chunks —
// the scale of a personal notes folder — without needing a real vector
// database and its setup overhead.
export function retrieveTopK(
  queryEmbedding: number[],
  index: IndexedChunk[],
  k: number = 4
): IndexedChunk[] {
  return index
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((result) => result.chunk);
}
