// Thin client for the Garrison app. The address is TOLD to us by the runner
// (GARRISON_APP_URL, projected with the instance-correct port) — never guessed
// from a port literal, which would name one instance and silently send another
// instance's traffic there (instance-isolation.test.ts). No env means no app:
// standalone runs outside the runner set GARRISON_APP_URL themselves or get
// degraded mode. Every method returns {ok, data|error} and never throws —
// app-down is a first-class, expected state (it is exactly when a doctor is
// needed).

import { execFile } from "node:child_process";
import path from "node:path";

import { FITTING_DIR, findRepoRoot } from "./collect.mjs";

// The runner-projected GARRISON_APP_URL always wins. But a CLI run from a plain
// shell has no such env, and treating that as "app down" made EVERY manual run
// degraded: the sweep unavailable, serve coverage silently downgraded to the
// weaker filesystem path, and a permanent warn at the top of the report. The
// supported, literal-free fallback is the instance script, which prints
// GARRISON_APP_PORT for an EXPLICIT profile.
//
// The profile defaults to "node" and NOT to what src/lib/instance-profile.ts
// resolves: that one defaults to "dev" so a bare `next dev` lands in the
// sandbox. Preflight audits the MACHINE, whose committed port map is the node
// map at offset 0, so inheriting a dev default would make a doctor run from a
// plain shell quietly report a sandbox's expectations as the machine's.
function profileFor(env) {
  const raw = (env.GARRISON_PREFLIGHT_PROFILE || env.GARRISON_INSTANCE_ID || "").trim();
  if (raw === "prod") return "node";
  return ["node", "dev", "codex"].includes(raw) ? raw : "node";
}

function instanceEnv(script, profile, root) {
  return new Promise((resolve) => {
    execFile("bash", [script, profile, "env"], { timeout: 15000, maxBuffer: 1024 * 1024, cwd: root },
      (err, stdout) => resolve(err && !stdout ? null : String(stdout ?? "")));
  });
}

async function discoverAppUrl(env) {
  const trim = (v) => (v || "").trim().replace(/\/+$/, "");
  const direct = trim(env.GARRISON_APP_URL) || trim(env.GARRISON_BASE_URL);
  if (direct) return direct;
  const configured = trim(env.GARRISON_PREFLIGHT_APP_URL);
  if (configured) return configured;
  const root = findRepoRoot(FITTING_DIR);
  if (!root) return null;
  const out = await instanceEnv(path.join(root, "scripts", "garrison-instance.sh"), profileFor(env), root);
  const m = out && out.match(/^GARRISON_APP_PORT=(\d+)\s*$/m);
  return m ? `http://127.0.0.1:${m[1]}` : null;
}

let pending = null;
let resolvedUrl = null;

function appUrlOnce(env = process.env) {
  if (!pending) pending = discoverAppUrl(env).then((u) => (resolvedUrl = u)).catch(() => null);
  return pending;
}

async function request(pathname, { method = "GET", body, timeoutMs = 2000 } = {}) {
  const APP_URL = await appUrlOnce();
  if (!APP_URL) return { ok: false, error: "no Garrison app URL could be discovered" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${APP_URL}${pathname}`, {
      method,
      signal: ctrl.signal,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => null);
    return res.ok ? { ok: true, data } : { ok: false, error: `HTTP ${res.status}`, data };
  } catch (err) {
    return { ok: false, error: err?.name === "AbortError" ? "timeout" : (err?.message || String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

export function appUrl() {
  return resolvedUrl || "(no app found: set GARRISON_APP_URL or the app_url config key)";
}

export async function isAppUp() {
  const res = await request("/api/fittings/views", { timeoutMs: 2000 });
  return res.ok;
}

// The runner's live state for one composition — carries the verifyResults of
// the most recent attempt, including a FAILED up (which last-up.json omits).
export async function fetchRunnerState(compositionId) {
  const res = await request(`/api/runner/${encodeURIComponent(compositionId)}/state`, { timeoutMs: 3000 });
  if (!res.ok) return null;
  return res.data?.state ?? null;
}

export async function fetchViews() {
  const res = await request("/api/fittings/views", { timeoutMs: 5000 });
  if (!res.ok) return null;
  return res.data?.views ?? res.data ?? null;
}

// The heavy, mutating call — the app's own verify path (same code up() runs).
// Only ever invoked from the explicit sweep action; 10 min budget.
export async function runVerifySweep(compositionId) {
  // The CLI also uses this function directly. Protect that entry point as well
  // as the HTTP mutation lane: verify() changes runner lifecycle state.
  const state = await fetchRunnerState(compositionId);
  if (!state || !["idle", "failed"].includes(state.status)) {
    return { ok: false, error: "Stop the composition before running its verify sweep; its current state must be idle or failed" };
  }
  const res = await request(`/api/runner/${encodeURIComponent(compositionId)}/verify`, {
    method: "POST",
    timeoutMs: 10 * 60 * 1000
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, results: res.data?.results ?? [] };
}
