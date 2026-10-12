import { load, read, run, equal, ensure, pass } from "../_lib.mjs";

// The tests are the specification: they must be left alone.
const tests = read("test/pricing.test.mjs");
ensure(tests.includes("applyDiscount(100, 0.2), 80"), "test/pricing.test.mjs was modified");
ensure(tests.includes("0.5), 15"), "test/pricing.test.mjs was modified");

const { applyDiscount, total, totalWithDiscount } = await load("src/pricing.mjs");
equal(applyDiscount(100, 0.2), 80, "applyDiscount(100, 0.2)");
equal(applyDiscount(50, 0), 50, "no discount");
equal(applyDiscount(50, 1), 0, "full discount");
equal(total([{ price: 10, qty: 2 }]), 20, "total must keep working");
equal(totalWithDiscount([{ price: 10, qty: 2 }, { price: 5, qty: 2 }], 0.5), 15, "totalWithDiscount");

const result = run(["--test"]);
ensure(result.status === 0, "`node --test` still fails");
pass();
