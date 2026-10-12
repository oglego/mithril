// Reads settings from the environment.
export function readConfig(env = process.env) {
  return {
    port: Number(env.APP_PORT ?? 4173),
    host: env.APP_HOST ?? "127.0.0.1",
    debug: env.APP_DEBUG === "1",
  };
}
