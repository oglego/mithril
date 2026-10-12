import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDiscount, total, totalWithDiscount } from "../src/pricing.mjs";

test("total adds up price times quantity", () => {
  assert.equal(total([{ price: 10, qty: 2 }, { price: 5, qty: 2 }]), 30);
});

test("applyDiscount takes a fraction off", () => {
  assert.equal(applyDiscount(100, 0.2), 80);
});

test("totalWithDiscount", () => {
  assert.equal(totalWithDiscount([{ price: 10, qty: 2 }, { price: 5, qty: 2 }], 0.5), 15);
});
