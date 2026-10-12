import { load, read, run, ensure, equal, pass } from "../_lib.mjs";

const result = run(["src/main.mjs"]);
ensure(result.status === 0, `src/main.mjs still crashes: ${result.stderr.split("\n").find((l) => l.includes("Error")) ?? ""}`);
equal(result.stdout.trim(), "listening on port 3000", "program output");
// The cause is in config.mjs; patching main.mjs to read the misspelled key would hide it.
const { loadConfig } = await load("src/config.mjs");
equal(loadConfig().server?.port, 3000, "loadConfig().server.port");
ensure(read("src/main.mjs").includes("config.server.port"), "src/main.mjs should still read config.server.port");
pass();
