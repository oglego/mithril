import { load, equal, ensure, pass } from "../_lib.mjs";

const mod = await load("src/clamp.mjs");
ensure(typeof mod.clamp === "function", "src/clamp.mjs must have a named export `clamp`");
const { clamp } = mod;
equal(clamp(5, 0, 10), 5, "inside the range");
equal(clamp(-1, 0, 10), 0, "below the range");
equal(clamp(11, 0, 10), 10, "above the range");
equal(clamp(5, 5, 5), 5, "min equals max");
let threw = false;
try {
  clamp(1, 10, 0);
} catch {
  threw = true;
}
ensure(threw, "min greater than max must throw");
pass();
