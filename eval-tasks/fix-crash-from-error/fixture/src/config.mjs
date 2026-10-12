const defaults = {
  sever: { port: 3000, host: "localhost" },
  logLevel: "info",
};

export function loadConfig() {
  return { ...defaults };
}
