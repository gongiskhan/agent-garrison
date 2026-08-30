// Every configurable value in this service is read here and nowhere else.
// Reading process.env from a route or a lib makes the configuration surface
// impossible to see, so load() is the only place it happens.

const DEFAULTS = {
  port: 3100,
  dbFile: "data/app.db",
  timezone: "UTC",
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function load(env = process.env) {
  return {
    port: num(env.PORT, DEFAULTS.port),
    dbFile: env.DB_FILE || DEFAULTS.dbFile,
    timezone: env.TZ_NAME || DEFAULTS.timezone,
  };
}
