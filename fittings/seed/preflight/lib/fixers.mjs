// Whitelisted fix executors — the ONLY mutations preflight can perform besides
// the verify sweep. Each action is narrow, parameter-validated, and does
// exactly what the finding's fix hint describes. Anything not in this registry
// (killing processes, editing verify'd code, choosing ports) stays a human
// decision on purpose.

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { servePort } from "./preflight-core.mjs";
import { findRepoRoot, GARRISON_HOME } from "./collect.mjs";
import { appUrl } from "./app-client.mjs";

const ID_RE = /^[\w.-]{1,200}$/;

const TAILSCALE_BINS = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale"
];

function execOk(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || err?.message || "") });
    });
  });
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${url} -> HTTP ${res.status}${data?.error ? ` (${data.error})` : ""}`);
  return data;
}

// Push the on-disk manifest to the state service (rev CAS). On an enrolled
// node the DB is the source of truth and up() reverts disk from it — a
// composition fix that skips this step silently undoes itself on the next up.
async function pushManifestToStateService(repoRoot, compositionId) {
  let state;
  try {
    state = JSON.parse(await readFile(path.join(GARRISON_HOME, "state.json"), "utf8"));
  } catch {
    return "node not enrolled (no state.json) — disk write is authoritative here";
  }
  if (!state?.url || !state?.token) return "state.json incomplete — skipped state push";
  const manifestYaml = await readFile(path.join(repoRoot, "compositions", compositionId, "apm.yml"), "utf8");
  const headers = { Authorization: `Bearer ${state.token}` };
  const current = await fetch(`${state.url}/v1/compositions/${encodeURIComponent(compositionId)}`, { headers })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const out = await fetchJson(`${state.url}/v1/compositions/${encodeURIComponent(compositionId)}`, {
    method: "PUT",
    headers: { ...headers, "If-Match": String(current?.rev ?? 0) },
    body: { manifestYaml }
  });
  return `state service updated to rev ${out.rev}`;
}

export const FIXERS = {
  // serve-coverage: register the tailscale serve mapping for one local port.
  "tailscale-serve-map": {
    validate: (p) => Number.isInteger(p?.port) && p.port > 0 && p.port < 65536,
    async run(p) {
      const sp = servePort(p.port);
      for (const bin of TAILSCALE_BINS) {
        const r = await execOk(bin, ["serve", "--bg", `--https=${sp}`, `http://127.0.0.1:${p.port}`]);
        if (r.ok) return { ok: true, detail: `mapped: serve ${sp} -> 127.0.0.1:${p.port}` };
        if (!/ENOENT|not found/i.test(r.err)) return { ok: false, error: r.err.slice(0, 400) };
      }
      return { ok: false, error: "tailscale binary not found" };
    }
  },

  // drift: remove a fitting from a composition THE RIGHT WAY — PUT without it
  // (writeComposition derives `unfitted`), then push the manifest to the state
  // service so the next up() cannot revert the removal.
  "unstation-fitting": {
    validate: (p) => ID_RE.test(p?.compositionId || "") && ID_RE.test(p?.fittingId || ""),
    async run(p) {
      const app = appUrl();
      if (app.startsWith("(")) return { ok: false, error: "Garrison app URL unknown (GARRISON_APP_URL not set)" };
      const got = await fetchJson(`${app}/api/compositions/${encodeURIComponent(p.compositionId)}`);
      const comp = got.composition;
      const selections = {};
      let removed = false;
      for (const [fac, items] of Object.entries(comp.selections || {})) {
        selections[fac] = (items || []).filter((it) => {
          if (it.id === p.fittingId) { removed = true; return false; }
          return true;
        });
      }
      if (!removed) return { ok: false, error: `${p.fittingId} is not selected in ${p.compositionId}` };
      await fetchJson(`${app}/api/compositions/${encodeURIComponent(p.compositionId)}`, {
        method: "PUT",
        body: { name: comp.name, selections, globalConfig: comp.globalConfig }
      });
      const root = findRepoRoot(process.cwd());
      const pushNote = root ? await pushManifestToStateService(root, p.compositionId) : "repo root not found — state push skipped";
      return { ok: true, detail: `${p.fittingId} unstationed from ${p.compositionId}; ${pushNote}` };
    }
  },

  // library-crosscheck: register a seed fitting with a minimal entry appended
  // at the tail of data/library.json (summary lifted from its manifest).
  "library-add-entry": {
    validate: (p) => ID_RE.test(p?.fittingId || ""),
    async run(p) {
      const root = findRepoRoot(process.cwd());
      if (!root) return { ok: false, error: "repo root not found" };
      const libPath = path.join(root, "data", "library.json");
      const lib = JSON.parse(await readFile(libPath, "utf8"));
      if (lib.some((e) => e.id === p.fittingId)) return { ok: false, error: "entry already exists" };
      const manifestPath = path.join(root, "fittings", "seed", p.fittingId, "apm.yml");
      let summary = `${p.fittingId} fitting.`;
      try {
        const text = await readFile(manifestPath, "utf8");
        const m = text.match(/^description:\s*(.+)$/m);
        if (m && m[1].trim() && m[1].trim() !== ">-") summary = m[1].trim();
      } catch {
        return { ok: false, error: `fittings/seed/${p.fittingId}/apm.yml not readable` };
      }
      lib.push({
        id: p.fittingId,
        name: p.fittingId,
        repo: `local:fittings/seed/${p.fittingId}`,
        localPath: `fittings/seed/${p.fittingId}`,
        summary,
        platforms: ["claude-code"]
      });
      await writeFile(libPath, JSON.stringify(lib, null, 2) + "\n", "utf8");
      return { ok: true, detail: `added ${p.fittingId} to data/library.json (uncommitted — review name/summary, then commit)` };
    }
  },

  // library-crosscheck: drop an entry whose seed directory no longer exists.
  "library-remove-entry": {
    validate: (p) => ID_RE.test(p?.entryId || ""),
    async run(p) {
      const root = findRepoRoot(process.cwd());
      if (!root) return { ok: false, error: "repo root not found" };
      const libPath = path.join(root, "data", "library.json");
      const lib = JSON.parse(await readFile(libPath, "utf8"));
      const next = lib.filter((e) => e.id !== p.entryId);
      if (next.length === lib.length) return { ok: false, error: "entry not found" };
      await writeFile(libPath, JSON.stringify(next, null, 2) + "\n", "utf8");
      return { ok: true, detail: `removed ${p.entryId} from data/library.json (uncommitted)` };
    }
  }
};

// Every executed fix is journaled — the user must be able to see WHAT the
// doctor did after the green row disappears on refresh. Append-only JSONL;
// a journal write failure never fails the fix itself.
const JOURNAL_PATH = path.join(GARRISON_HOME, "preflight-fixes.jsonl");

async function journal(entry) {
  try {
    const { appendFile, mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(JOURNAL_PATH), { recursive: true });
    await appendFile(JOURNAL_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch { /* best-effort */ }
}

export async function readFixJournal(limit = 20) {
  try {
    const text = await readFile(JOURNAL_PATH, "utf8");
    const lines = text.trim().split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

export async function runFix(actionId, params) {
  const fixer = FIXERS[actionId];
  if (!fixer) return { ok: false, error: `unknown action "${actionId}" — only whitelisted fixes run` };
  if (!fixer.validate(params || {})) return { ok: false, error: "invalid parameters" };
  let result;
  try {
    result = await fixer.run(params);
  } catch (err) {
    result = { ok: false, error: err?.message || String(err) };
  }
  await journal({ at: new Date().toISOString(), actionId, params, ...result });
  return result;
}
