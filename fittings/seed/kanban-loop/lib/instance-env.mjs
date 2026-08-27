// The INSTANCE IDENTITY a kanban scheduler job must carry.
//
// Its own module because BOTH scripts/kanban.mjs (the tick job) and
// lib/scheduler-beats.mjs (the per-list beat jobs) need it. Importing it from
// kanban.mjs instead created a cycle — kanban.mjs imports scheduler-beats at load,
// scheduler-beats would then dynamically import kanban.mjs mid-setup — which never
// settles and makes `node scripts/kanban.mjs --setup` exit 13, failing `up`.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The installed scheduler CLI (sibling fitting), overridable for tests — the
// same resolver scheduler-beats.mjs uses.
function schedulerCli() {
  return process.env.GARRISON_SCHEDULER_CLI
    || path.resolve(HERE, "..", "..", "scheduler", "scripts", "scheduler.mjs");
}

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

// The Garrison APP's base URL, same discipline as the gateway URL above: no
// literal fallback, resolve from the projected URL or the app port, else null.
export function resolveGarrisonBaseUrl() {
  const explicit = (process.env.GARRISON_BASE_URL || "").trim();
  if (explicit) return explicit;
  const port = (process.env.GARRISON_APP_PORT || "").trim();
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
    // Calendar sync runs from the tick and reaches the app (connector auth-env)
    // and the composition's installed connectors. Without these two the sync's
    // connectorCaller() resolved nothing and every beat reported "not-connected"
    // even with Google fully wired — indistinguishable from a real disconnect.
    GARRISON_BASE_URL: resolveGarrisonBaseUrl(),
    GARRISON_COMPOSITION_DIR: process.env.GARRISON_COMPOSITION_DIR
  };
  return Object.entries(vars)
    .filter(([, v]) => typeof v === "string" && v.trim() && !v.includes("'"))
    .map(([k, v]) => `${k}='${v.trim()}'`);
}

// Does the ALREADY-REGISTERED scheduler job carry a gateway URL? Asked of the
// SCHEDULER, never of its storage — that persisted command string is what actually
// runs, and outliving whichever process registered it is the entire point.
//
// This exists because registration happens from TWO places with different visibility:
// the apm.yml `--setup` hook (no gateway URL in scope) and the board server (which has
// one). Both re-register, so without this check whichever ran last wins, and the setup
// hook silently replaces a working job with a dead one.
//
// It reads through `scheduler.mjs list` rather than $GARRISON_HOME/scheduler-jobs.json
// because jobs moved into the mesh state service: on an enrolled node that file is
// frozen, so a direct read answered "nothing registered" every single time — which
// turns this guard into a no-op and re-opens exactly the downgrade it prevents. The CLI
// answers from whichever store is live (service when enrolled, the legacy file when
// not) and keeps the `command` projection either way.
export function registeredJobHasGateway(id) {
  try {
    const listing = execFileSync(process.execPath, [schedulerCli(), "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const jobs = JSON.parse(listing).jobs ?? [];
    const job = jobs.find((j) => j?.id === id);
    return typeof job?.command === "string" && /GARRISON_GATEWAY_URL=/.test(job.command);
  } catch {
    // An unreadable registry is "nothing to lose", exactly as before.
    return false;
  }
}

// Should this process register `id` at all? No, when it cannot resolve a gateway URL
// and the existing registration already has one — never downgrade a working job.
export function wouldDowngradeJob(id) {
  return !resolveGatewayUrl() && registeredJobHasGateway(id);
}
