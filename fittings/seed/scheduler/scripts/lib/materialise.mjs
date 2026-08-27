// Turning a STRUCTURED scheduler job into the command line this node runs.
//
// The pre-mesh job command was a fully-baked absolute string carrying checkout
// paths, homes and instance ports (kanban-loop's `instanceEnvPrefix()`). A
// baked string cannot be shared across machines, and a STALE bake is what left
// the prod tick dead for weeks on a dev port literal. A structured spec names
// node-resolved VALUES instead, and this module resolves them from the daemon's
// own env ~60 seconds before use rather than weeks before.
//
// The one rule that matters: a name that cannot be resolved SKIPS the run and
// says which name. Never guess, never substitute a default, never fall back to
// a literal — a job that silently does nothing is precisely the failure class
// this design exists to kill.

import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const trimmed = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

// A port becomes a loopback URL only when it really is a port. There is
// deliberately NO literal fallback anywhere in this file (HARD RULE: never
// hardcode a port) — an unresolvable port is a missing value, not a guess.
const portUrl = (port) => (/^\d+$/.test(String(port ?? "").trim()) ? `http://127.0.0.1:${String(port).trim()}` : null);

// `env_from` names node-resolved values, not literals. Each entry says which
// env var carries the value into the child and how this node resolves it.
export const ENV_FROM = {
  gateway_url: {
    envVar: "GARRISON_GATEWAY_URL",
    resolve: (env) => trimmed(env.GARRISON_GATEWAY_URL) ?? portUrl(env.GARRISON_GATEWAY_PORT)
  },
  garrison_home: {
    envVar: "GARRISON_HOME",
    resolve: (env) => trimmed(env.GARRISON_HOME)
  },
  kanban_dir: {
    envVar: "GARRISON_KANBAN_DIR",
    resolve: (env) => trimmed(env.GARRISON_KANBAN_DIR)
  },
  app_url: {
    envVar: "GARRISON_APP_URL",
    resolve: (env) => trimmed(env.GARRISON_APP_URL) ?? portUrl(env.GARRISON_APP_PORT)
  },
  outpost_url: {
    envVar: "GARRISON_OUTPOST_URL",
    resolve: (env) => trimmed(env.GARRISON_OUTPOST_URL) ?? portUrl(env.GARRISON_OUTPOST_PORT)
  },
  composition_dir: {
    envVar: "GARRISON_COMPOSITION_DIR",
    resolve: (env) => trimmed(env.GARRISON_COMPOSITION_DIR)
  },
  composition_id: {
    envVar: "GARRISON_COMPOSITION_ID",
    resolve: (env) => trimmed(env.GARRISON_COMPOSITION_ID)
  }
};

// POSIX single-quoting, done properly. instanceEnvPrefix() DROPPED any value
// containing a quote; dropping is silent, and silence is the thing being
// designed against here — so quote it correctly instead.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Locate a fitting's installed dir: an explicit override, then the composition's
// apm_modules/_local, then the repo seed dir. Same resolution shape (and the
// same "prove it by a marker file" discipline) as gateway-routing's
// resolveSecondaryDir — the marker here is the script the job wants to run.
export function resolveFittingDir(fitting, script, env = process.env, existsSync = fsSync.existsSync) {
  const slug = String(fitting).replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  const compositionDir = trimmed(env.GARRISON_COMPOSITION_DIR);
  const candidates = [
    env[`GARRISON_${slug}_DIR`],
    compositionDir && path.join(compositionDir, "apm_modules", "_local", fitting),
    path.resolve(HERE, "..", "..", "..", fitting)
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (existsSync(path.join(candidate, script))) return candidate;
    } catch {
      /* an unreadable candidate is simply not the one */
    }
  }
  return null;
}

/**
 * Build the command line for a job, at FIRE time, from this node's env.
 *
 * @returns {{ok: true, command: string, env: Record<string,string>}}
 *        | {{ok: false, reason: string, missing: string[]}}
 */
export function materialiseCommand(job, env = process.env, { existsSync } = {}) {
  const spec = job?.spec;
  if (!spec || typeof spec !== "object" || !spec.kind) {
    return { ok: false, reason: `job ${job?.id}: no spec.kind (expected "shell" or "fitting-script")`, missing: [] };
  }

  if (spec.kind === "shell") {
    // Verbatim. A shell spec's target is pinned to a single node by the
    // service (a Mac path must never be firable on Linux), so the string is
    // already this machine's.
    const command = trimmed(spec.command);
    if (!command) return { ok: false, reason: `job ${job.id}: shell spec carries no command`, missing: [] };
    return { ok: true, command, env: {} };
  }

  if (spec.kind !== "fitting-script") {
    return { ok: false, reason: `job ${job.id}: unknown spec.kind "${spec.kind}"`, missing: [] };
  }

  const fitting = trimmed(spec.fitting);
  const script = trimmed(spec.script);
  if (!fitting || !script) {
    return { ok: false, reason: `job ${job.id}: fitting-script spec needs both "fitting" and "script"`, missing: [] };
  }

  const dir = resolveFittingDir(fitting, script, env, existsSync);
  if (!dir) {
    return {
      ok: false,
      reason: `job ${job.id}: cannot locate ${fitting}/${script} (looked in GARRISON_COMPOSITION_DIR/apm_modules/_local and the repo seed dir)`,
      missing: [`fitting:${fitting}`]
    };
  }

  const missing = [];
  const resolved = {};
  for (const name of spec.env_from ?? []) {
    const entry = ENV_FROM[name];
    if (!entry) {
      missing.push(`${name} (no resolver — env_from names a node-resolved value, not an env var)`);
      continue;
    }
    const value = entry.resolve(env);
    if (!value) {
      missing.push(`${name} -> ${entry.envVar}`);
      continue;
    }
    resolved[entry.envVar] = value;
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `job ${job.id}: unresolved env_from on this node: ${missing.join(", ")}`,
      missing
    };
  }

  const args = (spec.args ?? []).map((arg) => shellQuote(arg));
  const prefix = Object.entries(resolved).map(([key, value]) => `${key}=${shellQuote(value)}`);
  const parts = [...prefix, "node", shellQuote(path.join(dir, script)), ...args];
  return { ok: true, command: parts.join(" "), env: resolved };
}
