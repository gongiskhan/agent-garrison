// Preflight collectors — all the I/O the pure core refuses to do: fs reads,
// lsof/git/tailscale exec, repo-root discovery. Every collector degrades to
// null / [] instead of throwing, so a missing tool or dir becomes an honest
// "could not check" row rather than a crashed report.

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseManifest, parseComposition } from "./preflight-core.mjs";

const HOME = os.homedir();
export const GARRISON_HOME = process.env.GARRISON_HOME || path.join(HOME, ".garrison");
export const STATUS_ROOT = path.join(GARRISON_HOME, "ui-fittings");

// ---------------------------------------------------------------------------
// Repo root: walk up from the fitting dir until data/library.json AND
// fittings/seed/ both exist. Works from fittings/seed/preflight and from
// <composition>/apm_modules/_local/preflight, since compositions live in-repo.
// ---------------------------------------------------------------------------
export function findRepoRoot(startDir, override = process.env.GARRISON_PREFLIGHT_REPO_ROOT) {
  if (override && override.trim()) {
    const abs = path.resolve(override.replace(/^~(?=\/|$)/, HOME));
    return existsSync(path.join(abs, "data", "library.json")) ? abs : null;
  }
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, "data", "library.json")) && existsSync(path.join(dir, "fittings", "seed"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function execOut(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? 10000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout) => {
      resolve(err && !stdout ? null : String(stdout ?? ""));
    });
  });
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function mtimeMs(file) {
  try { return statSync(file).mtimeMs; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Seed manifests + curated library
// ---------------------------------------------------------------------------
export function readSeedManifests(root) {
  const seedDir = path.join(root, "fittings", "seed");
  const out = [];
  let entries = [];
  try { entries = readdirSync(seedDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifest = path.join(seedDir, e.name, "apm.yml");
    if (!existsSync(manifest)) continue;
    try {
      out.push(parseManifest(readFileSync(manifest, "utf8"), e.name));
    } catch { /* unparseable seed: seed.test tolerates these when de-listed */ }
  }
  return out;
}

export function readCuratedLibrary(root) {
  return readJson(path.join(root, "data", "library.json")) || [];
}

// ---------------------------------------------------------------------------
// Compositions: parsed selections, last-up record, manifest mtimes, git state
// ---------------------------------------------------------------------------
export async function readCompositions(root) {
  const compDir = path.join(root, "compositions");
  const out = [];
  let entries = [];
  try { entries = readdirSync(compDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifest = path.join(compDir, e.name, "apm.yml");
    if (!existsSync(manifest)) continue;
    const text = readFileSync(manifest, "utf8");
    const parsed = parseComposition(text);
    const lastUp = readJson(path.join(compDir, e.name, ".garrison", "last-up.json"));
    const manifestMtimesMs = {
      "apm.yml": mtimeMs(manifest),
      "local.yml": mtimeMs(path.join(compDir, e.name, "local.yml")),
      "apm.lock.yaml": mtimeMs(path.join(compDir, e.name, "apm.lock.yaml"))
    };
    // git HEAD view of the same manifest, for re-station detection.
    const rel = path.relative(root, manifest).split(path.sep).join("/");
    const headText = await execOut("git", ["-C", root, "show", `HEAD:${rel}`]);
    const headParsed = headText ? parseComposition(headText) : null;
    const diffStat = await execOut("git", ["-C", root, "diff", "HEAD", "--stat", "--", rel]);
    out.push({
      compositionId: e.name,
      parsed,
      lastUp: lastUp && typeof lastUp === "object" ? lastUp : null,
      manifestMtimesMs,
      diskSelections: parsed.selections.map((s) => s.id),
      headSelections: headParsed ? headParsed.selections.map((s) => s.id) : null,
      unfitted: parsed.unfitted,
      diffStat: diffStat || null
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live listeners (macOS lsof; Linux ss fallback), status files, spawn ledger
// ---------------------------------------------------------------------------
export async function readLiveListeners() {
  const lsof = await execOut("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"]);
  if (lsof) {
    return lsof.split("\n").slice(1).map((line) => {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 9) return null;
      const m = cols[8].match(/:(\d+)$/);
      return m ? { port: Number(m[1]), pid: Number(cols[1]), command: cols[0] } : null;
    }).filter(Boolean);
  }
  const ss = await execOut("ss", ["-tlnpH"]);
  if (ss) {
    return ss.split("\n").map((line) => {
      const port = line.match(/[\s:](\d+)\s/);
      const pid = line.match(/pid=(\d+)/);
      const cmd = line.match(/users:\(\("([^"]+)"/);
      return port ? { port: Number(port[1]), pid: pid ? Number(pid[1]) : null, command: cmd ? cmd[1] : null } : null;
    }).filter(Boolean);
  }
  return [];
}

export function readStatusFiles() {
  const out = [];
  let entries = [];
  try { entries = readdirSync(STATUS_ROOT); } catch { return out; }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const data = readJson(path.join(STATUS_ROOT, name));
    if (data && data.fittingId && data.port) out.push(data);
  }
  return out;
}

export function readSpawnRecords() {
  const out = [];
  const dir = path.join(STATUS_ROOT, "spawn");
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const data = readJson(path.join(dir, name));
    if (data && data.fittingId && data.pid) out.push({ fittingId: data.fittingId, pid: data.pid });
    else {
      // Ledger files are sometimes keyed by filename with a bare pid inside.
      const id = name.replace(/\.json$/, "");
      if (data && typeof data.pid === "number") out.push({ fittingId: id, pid: data.pid });
    }
  }
  return out;
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) {
    return err && err.code === "EPERM"; // alive, owned by someone else
  }
}

// ---------------------------------------------------------------------------
// Tailscale serve map (degraded-mode source; the app's /api/fittings/views is
// the enriched source when 8777 is up). Mirrors src/lib/tailnet-serve.ts.
// ---------------------------------------------------------------------------
const TAILSCALE_BINS = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale"
];

export async function readTailscaleServeMap() {
  for (const bin of TAILSCALE_BINS) {
    const out = await execOut(bin, ["serve", "status", "--json"]);
    if (!out) continue;
    try {
      const data = JSON.parse(out);
      const map = {};
      for (const [hostPort, cfg] of Object.entries(data.Web || {})) {
        const proxy = cfg?.Handlers?.["/"]?.Proxy;
        const m = typeof proxy === "string" && proxy.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
        if (m) {
          const serve = hostPort.match(/:(\d+)$/);
          map[Number(m[1])] = `https://${hostPort.replace(/:(\d+)$/, "")}:${serve ? serve[1] : "443"}`;
        }
      }
      return map;
    } catch { /* not JSON — try next binary */ }
  }
  return null; // tailscale unavailable: caller reports "could not check", not a fail
}
