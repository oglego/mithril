import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, MAX_CHUNK_CHARS } from "./chunker.js";

test("splits content on ## headings", () => {
  const markdown = [
    "# Title",
    "",
    "Intro text.",
    "",
    "## Section One",
    "",
    "Content one.",
    "",
    "## Section Two",
    "",
    "Content two.",
  ].join("\n");

  const chunks = chunkMarkdown(markdown);

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.heading, "Introduction");
  assert.match(chunks[0]?.content ?? "", /Title/);
  assert.equal(chunks[1]?.heading, "Section One");
  assert.match(chunks[1]?.content ?? "", /Content one/);
  assert.equal(chunks[2]?.heading, "Section Two");
  assert.match(chunks[2]?.content ?? "", /Content two/);
});

test("returns a single 'Introduction' chunk when there are no ## headings", () => {
  const chunks = chunkMarkdown("Just some plain text with no headings at all.");

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.heading, "Introduction");
});

test("returns no chunks for empty or whitespace-only input", () => {
  assert.equal(chunkMarkdown("").length, 0);
  assert.equal(chunkMarkdown("   \n\n   ").length, 0);
});

test("splits a section larger than the size cap into multiple chunks", () => {
  const hugeContent = "x".repeat(MAX_CHUNK_CHARS * 2 + 500);
  const markdown = `## Big Section\n\n${hugeContent}`;

  const chunks = chunkMarkdown(markdown);

  assert.ok(chunks.length > 1, "expected the oversized section to be split into multiple chunks");
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= MAX_CHUNK_CHARS);
    assert.equal(chunk.heading, "Big Section");
  }
});

test("does not split a section that's exactly at the size cap", () => {
  const exactContent = "x".repeat(MAX_CHUNK_CHARS);
  const markdown = `## Exact Section\n\n${exactContent}`;

  const chunks = chunkMarkdown(markdown);

  assert.equal(chunks.length, 1);
});

test("splits oversized sections at paragraph boundaries without chopping words", () => {
  const p1 = "First paragraph with introductory context that is relatively long. ".repeat(20);
  const p2 = "Second paragraph covering different details in full sentences. ".repeat(20);
  const markdown = `## Two Paragraphs\n\n${p1}\n\n${p2}`;

  const chunks = chunkMarkdown(markdown);

  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= MAX_CHUNK_CHARS);
    assert.equal(chunk.heading, "Two Paragraphs");
    // Ensure chunks don't start or end with broken words
    assert.ok(!chunk.content.startsWith(" "));
    assert.ok(!chunk.content.endsWith(" "));
  }
});

