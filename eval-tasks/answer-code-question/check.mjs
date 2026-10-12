import { read, reply, ensure, pass } from "../_lib.mjs";

const answer = reply();
ensure(answer.includes("APP_PORT"), "the answer should name the APP_PORT variable");
ensure(answer.includes("4173"), "the answer should give the default port 4173");
ensure(read("src/config.mjs").includes("APP_PORT ?? 4173"), "src/config.mjs must not be changed");
pass();
