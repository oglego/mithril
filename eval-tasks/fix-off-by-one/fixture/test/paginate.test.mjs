import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/paginate.mjs";

test("first page", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 1, 2), [1, 2]);
});

test("last page can be partial", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 3, 2), [5]);
});
