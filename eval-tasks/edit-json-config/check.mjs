import assert from "node:assert/strict";
import { read, fail, pass } from "../_lib.mjs";

let parsed;
try {
  parsed = JSON.parse(read("config.json"));
} catch (err) {
  fail(`config.json is not valid JSON: ${err.message}`);
}
try {
  assert.deepStrictEqual(parsed, {
    name: "demo-service",
    server: { host: "0.0.0.0", port: 9090 },
    logging: { level: "debug", pretty: true },
    features: ["search", "export"],
  });
} catch (err) {
  fail(`config.json has the wrong contents: ${err.message.split("\n")[0]}`);
}
pass();
