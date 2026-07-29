// The INSTANCE IDENTITY a kanban scheduler job must carry.
//
// Its own module because BOTH scripts/kanban.mjs (the tick job) and
// lib/scheduler-beats.mjs (the per-list beat jobs) need it. Importing it from
// kanban.mjs instead created a cycle — kanban.mjs imports scheduler-beats at load,
// scheduler-beats would then dynamically import kanban.mjs mid-setup — which never
// settles and makes `node scripts/kanban.mjs --setup` exit 13, failing `up`.

// The gateway URL the tick dispatches through. There is deliberately NO literal
// port fallback (HARD RULE: never hardcode a port). The old fallback was
// `http://127.0.0.1:4777` — the DEV gateway — so on prod (gateway :5777) and codex
// (:24777) the scheduler tick pinged the wrong instance, found nothing, and logged
// "gateway not reachable" every 2 minutes for as long as prod had been running.
// Nothing was ever dispatched, advanced, retried or reaped by the tick, and because
// the literal happened to be RIGHT on dev the whole failure was invisible in
// development. `--tick` inherits only the scheduler daemon's env, which carries no
// gateway URL, so registerTick() bakes the resolved URL into the job command
// (instanceEnvPrefix) exactly as the weekly-review job bakes its stall threshold.
// Returns null when the instance is unknown — the caller then says so loudly
// instead of guessing an instance and silently doing nothing.
export function resolveGatewayUrl() {
  const explicit = (process.env.GARRISON_GATEWAY_URL || "").trim();
  if (explicit) return explicit;
  const port = (process.env.GARRISON_GATEWAY_PORT || "").trim();
  if (/^[0-9]+$/.test(port)) return `http://127.0.0.1:${port}`;
  return null;
}

// The instance-identifying env baked into every scheduler job command this fitting
// registers. The scheduler daemon runs jobs through `sh -c` with ITS OWN env, which
// never carries the composition's projected values — so a job that needs them must
// carry them itself (the pattern the weekly-review job already used for its stall
// threshold). Without this the tick cannot tell prod from dev from codex.
// Values are single-quoted for `sh -c`; anything containing a quote is dropped
// rather than escaped (these are ports, URLs and paths — never quoted strings).
export function instanceEnvPrefix() {
  const vars = {
    GARRISON_GATEWAY_URL: resolveGatewayUrl(),
    GARRISON_HOME: process.env.GARRISON_HOME,
    GARRISON_KANBAN_DIR: process.env.GARRISON_KANBAN_DIR,
    // The outpost daemon is instance-specific too, and the engine's affinity resolver
    // has no fallback by design (its old literal named the codex port and parked every
    // affinity card). Without this the tick cannot resolve an outpost either, and every
    // outpost-affinity card it touches parks with "outpost offline".
    GARRISON_KANBANLOOP_OUTPOST_HOST_URL: process.env.GARRISON_KANBANLOOP_OUTPOST_HOST_URL,
    GARRISON_OUTPOST_URL: process.env.GARRISON_OUTPOST_URL
  };
  return Object.entries(vars)
    .filter(([, v]) => typeof v === "string" && v.trim() && !v.includes("'"))
    .map(([k, v]) => `${k}='${v.trim()}'`);
}
