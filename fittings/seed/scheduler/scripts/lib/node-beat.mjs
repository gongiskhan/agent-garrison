// Node heartbeat pump.
//
// Every 15s: GET this node's own /api/mesh/self over loopback, then POST it to
// the state service as this node's health. Three misses (45s) and every other
// node's /mesh shows this one OFFLINE.
//
// Why the scheduler daemon owns the interval and not the Next app: route
// modules are evicted and re-instantiated, so a module-level setInterval in a
// route file is not a daemon. The scheduler is the one always-on single process
// per instance, and it is already launched on every profile.
//
// The daemon is a DUMB PUMP. All gathering logic lives in the app, where the
// readers already are — this file must never grow a probe of its own, or the
// beat and the /mesh row start disagreeing about the same machine.
//
// Nothing here may throw into the daemon. A node that is not enrolled yet, or
// whose app is still booting, must beat nothing and keep ticking cron jobs.
//
// It does report, on every beat, whether the app answered at all (see
// `appReachable` on gather). That is an observation of the probe it already
// makes, not a probe of its own; the policy that acts on a run of them lives in
// lib/app-watchdog.mjs.

import fsSync from "node:fs";
import { createStateClient } from "./state-client.mjs";

export const BEAT_INTERVAL_MS = 15_000;
const GATHER_TIMEOUT_MS = 5_000;
const POST_TIMEOUT_MS = 5_000;

// Resolved from the env the launcher already exports. GARRISON_APP_URL wins
// when set; otherwise the app port the launcher projected. Never a literal —
// a hardcoded port here would make one instance's scheduler beat the OTHER
// instance's health into the registry.
export function resolveAppUrl(env = process.env) {
  const explicit = env.GARRISON_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = env.GARRISON_APP_PORT?.trim() || env.PORT?.trim();
  if (port && /^\d+$/.test(port)) return `http://127.0.0.1:${port}`;
  return null;
}

export function createNodeBeat({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.error,
  intervalMs = BEAT_INTERVAL_MS,
  readFileSync = fsSync.readFileSync,
  // Every beat outcome, handed to whoever wants an opinion about it. The pump
  // keeps none: see lib/app-watchdog.mjs, which turns a run of unreachable
  // beats into a restart. A throw here must never break the beat.
  onBeat = null
} = {}) {
  let client = null;
  let timer = null;
  let stopped = false;
  // One line per DISTINCT condition, not one per beat: a node that has been
  // unenrolled for a week must not write 40k identical lines into the log, and
  // a condition that CHANGES must still be reported.
  let lastComplaint = null;

  const complain = (key, message) => {
    if (lastComplaint === key) return;
    lastComplaint = key;
    log(`[node-beat] ${message}`);
  };
  const recover = (message) => {
    if (lastComplaint === null) return;
    lastComplaint = null;
    if (message) log(`[node-beat] ${message}`);
  };

  // `appReachable` is the one fact a liveness watcher needs and the only one
  // this pump is in a position to know: false means the probe THREW - nothing
  // is listening on the app port. An app that answers 500 is reachable and
  // broken, which is a different problem with a different cure, so it reports
  // true. No app URL at all reports null: unknown, not down.
  async function gather() {
    const appUrl = resolveAppUrl(env);
    if (!appUrl) {
      complain(
        "no-app-url",
        "neither GARRISON_APP_URL nor GARRISON_APP_PORT is set; this node will not report health until the launcher projects one"
      );
      return { health: null, appReachable: null };
    }
    let res;
    try {
      res = await fetchImpl(`${appUrl}/api/mesh/self`, {
        signal: AbortSignal.timeout(GATHER_TIMEOUT_MS),
        cache: "no-store"
      });
    } catch (err) {
      complain("gather-failed", `could not read /api/mesh/self: ${err?.message ?? err}`);
      return { health: null, appReachable: false, reason: "gather-failed" };
    }
    if (!res.ok) {
      complain(`self-${res.status}`, `${appUrl}/api/mesh/self answered ${res.status}; skipping this beat`);
      return { health: null, appReachable: true };
    }
    try {
      return { health: await res.json(), appReachable: true };
    } catch (err) {
      complain("self-body", `${appUrl}/api/mesh/self answered with a body that is not JSON: ${err?.message ?? err}`);
      return { health: null, appReachable: true };
    }
  }

  // Discovery is retried on EVERY beat rather than memoised as a fatal: a node
  // installed before its enrolment code is pasted must start beating the
  // moment state.json lands, with no restart.
  function resolveClient() {
    if (client) return client;
    client = createStateClient({ env, readFileSync, fetchImpl, timeoutMs: POST_TIMEOUT_MS });
    return client;
  }

  const finish = (result) => {
    if (onBeat) {
      try {
        void Promise.resolve(onBeat(result)).catch(() => {});
      } catch {
        // An observer's opinion is never worth a missed beat.
      }
    }
    return result;
  };

  async function beatOnce() {
    let gathered;
    try {
      gathered = await gather();
    } catch (err) {
      // gather() is written not to throw; if it ever does, the app not
      // answering is still the likeliest reading of it.
      complain("gather-failed", `could not read /api/mesh/self: ${err?.message ?? err}`);
      gathered = { health: null, appReachable: false, reason: "gather-failed" };
    }
    const { health, appReachable } = gathered;
    if (!health) return finish({ beat: false, reason: gathered.reason ?? "no-health", appReachable });

    let stateClient;
    try {
      stateClient = resolveClient();
    } catch (err) {
      complain("not-enrolled", `not enrolled in a mesh yet: ${err?.message ?? err}`);
      return finish({ beat: false, reason: "not-enrolled", appReachable });
    }

    try {
      const result = await stateClient.hello({
        clientVersion: health.clientVersion,
        minSchema: health.schemaVersion?.min,
        maxSchema: health.schemaVersion?.max,
        capabilities: capabilitiesFrom(health),
        localTime: new Date().toISOString(),
        health,
        activeComposition: health.composition?.id ?? undefined,
        tailnetHost: health.node?.tailnetHost ?? undefined,
        platform: health.platform ?? undefined,
        // node.json is the identity authority; the registry row is a replica.
        // Carrying the resolved accent on every beat is what keeps a peer's
        // node dot the same colour the node paints itself.
        accentColor: health.node?.accentHex ?? undefined
      });
      if (result?.behind) {
        complain(
          "behind",
          `this node's schema window ${health.schemaVersion?.min}-${health.schemaVersion?.max} no longer covers the service's ${result.schemaVersion}; its writes are refused until it converges`
        );
      } else {
        recover("reporting health to the state service again");
      }
      return finish({ beat: true, behind: Boolean(result?.behind), appReachable });
    } catch (err) {
      // Discovery may have produced a client for a service that has since
      // moved or rotated its token; drop it so the next beat rediscovers.
      client = null;
      complain(`post-${err?.status ?? "unreachable"}`, `could not report health: ${err?.message ?? err}`);
      return finish({ beat: false, reason: "post-failed", appReachable });
    }
  }

  function start() {
    if (timer) return;
    void beatOnce();
    timer = setInterval(() => {
      if (stopped) return;
      void beatOnce();
    }, intervalMs);
    // The beat must never be the reason this process stays alive.
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, beatOnce, get client() { return client; } };
}

// What this node can currently serve, which is exactly its healthy own-port
// views. Reported as capabilities so a peer can route to a node by what is
// actually answering there, not by what its manifest claims.
function capabilitiesFrom(health) {
  const caps = ["garrison-app"];
  const views = health?.views;
  if (views && Number.isFinite(views.healthy) && views.healthy > 0) caps.push("views");
  if (health?.composition?.running) caps.push("composition-up");
  return caps;
}

// Returns null (never throws) when the beat is disabled, so the caller can
// wire it in unconditionally.
export function startNodeBeat(options = {}) {
  const env = options.env ?? process.env;
  if (env.GARRISON_DISABLE_NODE_BEAT === "1") return null;
  const beat = createNodeBeat(options);
  beat.start();
  return beat;
}
