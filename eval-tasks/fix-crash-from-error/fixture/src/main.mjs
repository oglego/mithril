import { loadConfig } from "./config.mjs";

const config = loadConfig();
console.log(`listening on port ${config.server.port}`);
