const defaults = {
  server: { port: 3000, host: "localhost" },
  logLevel: "info",
};

export function loadConfig() {
  return { ...defaults };
}
