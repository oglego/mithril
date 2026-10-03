import type { IndexedChunk } from "./indexer.js";

// Measures how similar two vectors' directions are (1 = identical, 0 =
// unrelated, -1 = opposite), independent of their magnitude. Standard
// similarity measure for comparing embeddings.
export function cosineSimilarity(a: number[], b: number[]): number {
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

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// Optimized cosine similarity where query norm has already been computed,
// avoiding O(N) redundant calculations of the same query norm.
function cosineSimilarityWithQueryNorm(
  query: number[],
  queryNorm: number,
  chunkVec: number[]
): number {
  let dot = 0;
  let chunkNormSq = 0;

  for (let i = 0; i < query.length; i++) {
    const qi = query[i] ?? 0;
    const ci = chunkVec[i] ?? 0;
    dot += qi * ci;
    chunkNormSq += ci * ci;
  }

  const chunkNorm = Math.sqrt(chunkNormSq);
  const denom = queryNorm * chunkNorm;
  if (denom === 0) return 0;
  return dot / denom;
}

// Scores every chunk against the query and returns the top K in O(N * K) time
// rather than sorting the entire index array O(N log N).
export function retrieveTopK(
  queryEmbedding: number[],
  index: IndexedChunk[],
  k: number = 4
): IndexedChunk[] {
  if (index.length === 0 || k <= 0) return [];

  let queryNormSq = 0;
  for (let i = 0; i < queryEmbedding.length; i++) {
    const v = queryEmbedding[i] ?? 0;
    queryNormSq += v * v;
  }
  const queryNorm = Math.sqrt(queryNormSq);
  if (queryNorm === 0) return [];

  // Maintain top K candidates sorted descending by score
  const topCandidates: { chunk: IndexedChunk; score: number }[] = [];

  for (let i = 0; i < index.length; i++) {
    const chunk = index[i]!;
    const score = cosineSimilarityWithQueryNorm(queryEmbedding, queryNorm, chunk.embedding);

    if (topCandidates.length < k) {
      topCandidates.push({ chunk, score });
      topCandidates.sort((a, b) => b.score - a.score);
    } else if (score > topCandidates[k - 1]!.score) {
      topCandidates[k - 1] = { chunk, score };
      topCandidates.sort((a, b) => b.score - a.score);
    }
  }

  return topCandidates.map((c) => c.chunk);
}

