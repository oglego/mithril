import { test } from "node:test";
import assert from "node:assert/strict";
import { retrieveTopK } from "./retriever.js";
import type { IndexedChunk } from "./indexer.js";

function makeChunk(id: string, embedding: number[]): IndexedChunk {
  return { filePath: id, heading: id, content: id, embedding };
}

test("ranks chunks by cosine similarity, most similar first", () => {
  const index: IndexedChunk[] = [
    makeChunk("opposite", [-1, 0]), // deliberately out of order, to prove sorting happens
    makeChunk("perpendicular", [0, 1]), // unrelated direction
    makeChunk("same-direction", [1, 0]), // identical direction to the query
  ];

  const results = retrieveTopK([1, 0], index, 3);

  assert.equal(results[0]?.filePath, "same-direction");
  assert.equal(results[1]?.filePath, "perpendicular");
  assert.equal(results[2]?.filePath, "opposite");
});

test("respects the k limit even when more chunks are available", () => {
  const index: IndexedChunk[] = [
    makeChunk("a", [1, 0]),
    makeChunk("b", [0.9, 0.1]),
    makeChunk("c", [0.5, 0.5]),
    makeChunk("d", [0, 1]),
  ];

  const results = retrieveTopK([1, 0], index, 2);
  assert.equal(results.length, 2);
});

test("returns an empty array when the index is empty", () => {
  const results = retrieveTopK([1, 0], [], 4);
  assert.deepEqual(results, []);
});

test("is unaffected by vector magnitude, only direction", () => {
  // A long vector and a short vector pointing the same way should rank
  // identically — cosine similarity measures angle, not length.
  const index: IndexedChunk[] = [
    makeChunk("short", [1, 0]),
    makeChunk("long", [100, 0]),
    makeChunk("off-axis", [1, 1]),
  ];

  const results = retrieveTopK([1, 0], index, 3);

  // "short" and "long" are both perfectly aligned with the query, so they
  // should be the top two results, ahead of "off-axis" — regardless of
  // which of the two tied results sorts first.
  const topTwo = results.slice(0, 2).map((r) => r.filePath).sort();
  assert.deepEqual(topTwo, ["long", "short"]);
});
