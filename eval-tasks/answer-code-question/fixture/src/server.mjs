import { readConfig } from "./config.mjs";

const config = readConfig();
console.log(`would listen on ${config.host}:${config.port}`);
