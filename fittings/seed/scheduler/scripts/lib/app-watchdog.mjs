// App liveness watchdog.
//
// The failure this exists for, observed on dev-madrid 2026-09-21: something
// delivered SIGTERM to the `next start` child alone. Next did what Node servers
// do on SIGTERM - called server.close(), which stops accepting and keeps the
// connections it already has - and then never exited, because one long-lived
// SSE stream through the tailnet proxy never drained. The listening socket was
// gone; the pid was not. `concurrently` saw no child exit, so systemd saw no
// failure, so Restart=always never fired, and `systemctl is-active` reported
// `active (running)` for nine hours while the node served nothing.
//
// The lesson is the whole design: the unit's own state is NOT a liveness signal
// for this unit. The only honest one is an HTTP probe of the app port, which
// node-beat already makes every 15s. This module is the policy on top of that
// pump, kept separate so node-beat stays the dumb pump it documents itself as.
//
// Restarting the unit is the cure because nothing gentler reaches the wedged
// process: it is not ignoring a signal, it is waiting on a socket that will
// never close.

import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

// A TIME budget, not a beat count, so it does not silently change meaning when
// BEAT_INTERVAL_MS does. Five minutes is longer than any legitimate window in
// which the app is unreachable while the scheduler is still ticking, and short
// enough to turn a nine-hour outage into a five-minute one.
export const UNREACHABLE_BUDGET_MS = 5 * 60_000;

// Heals are rate limited through a FILE, because the process that would hold
// the counter in memory is the process the heal kills. Three in an hour and it
// stops trying: a node that cannot stay up is a human's problem, and a restart
// loop takes the composition down with it every single time.
export const HEAL_WINDOW_MS = 60 * 60_000;
export const MAX_HEALS_PER_WINDOW = 3;

export function healRecordPath(env = process.env) {
  const home = env.GARRISON_HOME?.trim();
  if (!home) return null;
  return path.join(home, "node-watchdog.json");
}

// The unit to restart is read from our own cgroup rather than configured,
// because a configured name is a name that can be wrong - and being wrong here
// means restarting a unit that is not us.
//
// Two rejections matter. `user@1001.service` also appears in that cgroup path
// and restarting it would take the entire user session down, so only the LAST
// path segment is considered and a `user@` name is refused. And a scheduler
// started by hand from a terminal sits in a `.scope`, not a `.service`, so it
// resolves to nothing and heals nothing.
export function resolveUnit({ env = process.env, readFileSync = fsSync.readFileSync } = {}) {
  // systemd sets INVOCATION_ID for a unit's processes and nothing else does.
  // Without it we are not running under a unit, whatever the cgroup says.
  if (!env.INVOCATION_ID?.trim()) return null;
  let cgroup;
  try {
    cgroup = readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return null;
  }
  const segments = String(cgroup)
    .split("\n")
    .map((line) => line.split(":").pop() ?? "")
    .flatMap((p) => p.split("/"))
    .filter(Boolean);
  const unit = segments[segments.length - 1];
  if (!unit || !unit.endsWith(".service")) return null;
  if (unit.startsWith("user@")) return null;
  return unit;
}

function defaultRestart(unit) {
  return new Promise((resolve) => {
    // --no-block is load-bearing. We are inside the unit we are restarting, so
    // systemd kills this process as part of the stop; without it the call is
    // killed mid-wait and we never learn whether the job was even queued.
    execFile(
      "systemctl",
      ["--user", "restart", "--no-block", unit],
      { timeout: 10_000 },
      (err) => resolve({ queued: !err, error: err ? (err.message ?? String(err)) : null })
    );
  });
}

function readHeals({ env, readFileSync, now }) {
  const file = healRecordPath(env);
  if (!file) return { file: null, heals: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { file, heals: [] };
  }
  const heals = Array.isArray(parsed?.heals) ? parsed.heals : [];
  const cutoff = now() - HEAL_WINDOW_MS;
  return {
    file,
    heals: heals.filter((entry) => {
      const at = Date.parse(entry?.at ?? entry);
      return Number.isFinite(at) && at >= cutoff;
    })
  };
}

export function createAppWatchdog({
  env = process.env,
  log = console.error,
  now = () => Date.now(),
  readFileSync = fsSync.readFileSync,
  writeFileSync = fsSync.writeFileSync,
  restart = defaultRestart,
  budgetMs = UNREACHABLE_BUDGET_MS
} = {}) {
  let downSince = null;
  let healing = false;
  // One line per DISTINCT condition, the same discipline node-beat keeps: a
  // sandbox that can never heal must not write a line every fifteen seconds.
  let lastComplaint = null;

  const complain = (key, message) => {
    if (lastComplaint === key) return;
    lastComplaint = key;
    log(`[app-watchdog] ${message}`);
  };

  async function record(result) {
    // Only HARD unreachability counts - the probe threw, nothing is listening.
    // An app that answers 500, a state service that is down, a node not yet
    // enrolled: none of those are this failure. Restarting every node in the
    // mesh because dev-madrid's state service blinked would be a far worse
    // outage than the one this prevents.
    if (result?.appReachable !== false) {
      if (downSince !== null) {
        log(`[app-watchdog] app answering again after ${Math.round((now() - downSince) / 1000)}s`);
      }
      downSince = null;
      lastComplaint = null;
      return { state: "ok" };
    }

    if (downSince === null) {
      downSince = now();
      return { state: "watching", downMs: 0 };
    }

    const downMs = now() - downSince;
    if (downMs < budgetMs) return { state: "watching", downMs };
    if (healing) return { state: "healing", downMs };

    const unit = resolveUnit({ env, readFileSync });
    if (!unit) {
      complain(
        "no-unit",
        "the app has been unreachable for over " +
          `${Math.round(budgetMs / 1000)}s and this process is not running under a systemd user unit, ` +
          "so it cannot restart itself; restart the instance by hand"
      );
      return { state: "no-unit", downMs };
    }

    const { file, heals } = readHeals({ env, readFileSync, now });
    if (heals.length >= MAX_HEALS_PER_WINDOW) {
      complain(
        "capped",
        `${unit} has already been restarted ${heals.length} times in the last hour and the app is still ` +
          "unreachable; not restarting again - this needs a human"
      );
      return { state: "capped", downMs, unit, heals: heals.length };
    }

    healing = true;
    try {
      const at = new Date(now()).toISOString();
      if (file) {
        try {
          writeFileSync(file, JSON.stringify({ heals: [...heals, { at, unit, downMs }] }, null, 2));
        } catch (err) {
          // A record we cannot write is not a reason to leave the node down,
          // but it does mean the cap is not holding, so say it every time.
          log(`[app-watchdog] could not record the heal in ${file}: ${err?.message ?? err}`);
        }
      }
      log(
        `[app-watchdog] app unreachable for ${Math.round(downMs / 1000)}s; restarting ${unit} ` +
          `(heal ${heals.length + 1} of ${MAX_HEALS_PER_WINDOW} this hour)`
      );
      const outcome = await restart(unit);
      if (!outcome?.queued) {
        log(`[app-watchdog] could not restart ${unit}: ${outcome?.error ?? "unknown error"}`);
      }
      // Reset either way. If the restart did happen this process is about to
      // die; if it did not, the node gets another full budget before we spend
      // one of the three attempts again.
      downSince = null;
      return { state: "healed", downMs, unit, queued: Boolean(outcome?.queued) };
    } finally {
      healing = false;
    }
  }

  return {
    record,
    get downSince() {
      return downSince;
    }
  };
}

// Returns null (never throws) when the watchdog is disabled, so the caller can
// wire it in unconditionally.
export function startAppWatchdog(options = {}) {
  const env = options.env ?? process.env;
  if (env.GARRISON_DISABLE_APP_WATCHDOG === "1") return null;
  return createAppWatchdog(options);
}
