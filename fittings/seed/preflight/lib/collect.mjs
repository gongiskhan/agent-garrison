// Preflight collectors — all the I/O the pure core refuses to do: fs reads,
// lsof/git/tailscale exec, repo-root discovery. Every collector degrades to
// null / [] instead of throwing, so a missing tool or dir becomes an honest
// "could not check" row rather than a crashed report.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseManifest, parseComposition, resolveScriptPaths, RETIRED_SEED_IDS } from "./preflight-core.mjs";

// The fitting's own location. It always sits inside the repo it diagnoses
// (fittings/seed/preflight, or <composition>/apm_modules/_local/preflight), so
// it is a far better root-discovery anchor than the caller's cwd.
export const FITTING_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    if (!e.isDirectory() || RETIRED_SEED_IDS.has(e.name)) continue;
    const manifest = path.join(seedDir, e.name, "apm.yml");
    if (!existsSync(manifest)) continue;
    try {
      out.push(parseManifest(readFileSync(manifest, "utf8"), e.name));
    } catch (err) {
      // A manifest preflight cannot read is a manifest whose port claims and
      // capability kinds are invisible to every other check. Swallowing it made
      // the doctor quietly less thorough with no way to notice.
      out.push({ id: e.name, ownPort: false, defaultPort: null, portKeys: [], kinds: [], parseError: String(err?.message || err) });
    }
  }
  return out;
}

// The canonical active-composition pointer, read straight off disk so it works
// with the app down — which is exactly when the doctor is needed. Mirrors the
// semantics of src/lib/active-composition.ts: the pointer is either a plain id
// or a path to an apm.yml. Returns null when there is no usable pointer, and
// callers then rank NOTHING, so an unreadable config can never demote a real
// finding into silence.
export function readActiveComposition({ home = GARRISON_HOME } = {}) {
  const doc = readJson(path.join(home, "config.json"));
  const raw = doc && typeof doc.active_composition === "string" ? doc.active_composition.trim() : "";
  if (!raw) return null;
  if (!raw.includes("/") && !raw.includes(path.sep) && !/\.ya?ml$/i.test(raw)) return raw;
  const abs = path.resolve(raw.replace(/^~(?=\/|$)/, HOME));
  return path.basename(/\.ya?ml$/i.test(abs) ? path.dirname(abs) : abs) || null;
}

// A tailscale serve mapping whose local port has no listener is a tailnet URL
// that resolves to nothing — the same blank page check 4 exists to prevent,
// arriving from the opposite direction. Tethered PEER forwards are published
// with an explicit servePort from tether.json and must not be judged as this
// node's own views (scripts/tailnet-serve-tether.mjs).
export function readTetheredPorts({ home = GARRISON_HOME } = {}) {
  const doc = readJson(path.join(home, "remote-shell", "tether.json"));
  const forwards = Array.isArray(doc?.forwards) ? doc.forwards : [];
  return new Set(forwards.map((f) => Number(f.localPort)).filter(Number.isInteger));
}

// The canonical capability-kind vocabulary, read as text from the source of
// truth. A .mjs fitting that must run on a cold machine cannot import the .ts,
// and a hand-copied list is exactly the drift this check exists to catch —
// tests/preflight-parity.test.ts pins the two together.
// Mirrors src/lib/instance-profile.ts. Pinned by tests/preflight-parity.test.ts.
export const PROFILE_PORT_OFFSET = { node: 0, dev: 10000, codex: 20000 };

// Deliberately NOT src/lib/instance-profile.ts's currentProfile(), which
// defaults to "dev" so a bare `next dev` lands in the sandbox. Preflight audits
// the MACHINE, whose committed port map is the node map at offset 0; inheriting
// a dev default would have a doctor run from a plain shell quietly report a
// sandbox's expectations as the machine's.
export function resolveProfile(env = process.env) {
  const raw = (env.GARRISON_PREFLIGHT_PROFILE || env.GARRISON_INSTANCE_ID || "").trim();
  if (raw === "prod") return "node";
  return Object.hasOwn(PROFILE_PORT_OFFSET, raw) ? raw : "node";
}

// The `command:` of the setup and verify blocks, by line scan: a full YAML
// parser is not available to a fitting that must run from apm_modules on a
// cold machine, and the shape here is fixed.
function hookCommands(text) {
  const lines = text.split(/\r?\n/);
  const out = {};
  let mode = null;
  let modeIndent = -1;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (/^(setup|verify):\s*$/.test(line)) { mode = line.slice(0, -1); modeIndent = indent; continue; }
    if (mode && indent <= modeIndent) { mode = null; continue; }
    const cmd = mode && line.match(/^command:\s*(.+?)\s*$/);
    if (cmd) { out[mode] = cmd[1]; mode = null; }
  }
  return out;
}

// The script a hook command runs, relative to that hook's own root.
function scriptFromCommand(command) {
  const m = String(command || "").match(/(\S+\.(?:sh|mjs|js|ts))\b/);
  return m ? m[1] : null;
}

const joinRel = (base, rel) => path.resolve(base, "." + (rel.startsWith("/") ? rel : `/${rel}`));

// Setup runs from the SEED dir and verify from the COMPOSITION dir
// (src/lib/runner.ts:1465 vs :1625), so a path either script derives by walking
// up from its own location resolves to two different places. Collect those
// pairs so the pure check can decide which ones actually diverge.
export function readHookScripts(root, compositions = [], activeCompositionId = null) {
  const seedDir = path.join(root, "fittings", "seed");
  const out = [];
  let entries = [];
  try { entries = readdirSync(seedDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || RETIRED_SEED_IDS.has(e.name)) continue;
    let manifest;
    try { manifest = readFileSync(path.join(seedDir, e.name, "apm.yml"), "utf8"); } catch { continue; }
    const hooks = hookCommands(manifest);
    const setupRel = scriptFromCommand(hooks.setup);
    const verifyRel = scriptFromCommand(hooks.verify);
    if (!setupRel || !verifyRel) continue;

    // Which composition stations it decides where verify would run from;
    // prefer the active one so the report describes the machine in use.
    const stationing = compositions.filter((c) => c.parsed.selections.some((s) => s.id === e.name));
    const comp = stationing.find((c) => c.compositionId === activeCompositionId) || stationing[0];
    if (!comp) continue;

    // Both scripts live in the seed; only the ROOT they run from differs.
    const setupScriptDir = path.dirname(path.resolve(path.join(seedDir, e.name), setupRel));
    const verifyScriptDir = path.dirname(path.resolve(path.join(root, "compositions", comp.compositionId), verifyRel));
    let setupText, verifyText;
    try {
      setupText = readFileSync(path.join(seedDir, e.name, setupRel), "utf8");
      verifyText = readFileSync(path.join(seedDir, e.name, verifyRel.replace(/^.*_local\/[^/]+\//, "")), "utf8");
    } catch { continue; }

    const fromSetup = resolveScriptPaths(setupText, setupScriptDir, joinRel);
    const fromVerify = resolveScriptPaths(verifyText, verifyScriptDir, joinRel);
    const vars = [];
    for (const [name, s] of fromSetup) {
      if (name === "SCRIPT_DIR") continue;
      const v = fromVerify.get(name);
      // Only variables BOTH scripts define the same way can be compared; a name
      // that means different things in the two scripts proves nothing.
      if (!v || v.expr !== s.expr) continue;
      const guarded = new RegExp(`basename[ \t]+"\\$${name}"`).test(setupText);
      vars.push({
        name, expr: s.expr, setupPath: s.path, verifyPath: v.path,
        setupExists: existsSync(s.path), verifyExists: existsSync(v.path), guarded
      });
    }
    if (vars.length) out.push({ id: e.name, compositionId: comp.compositionId, vars });
  }
  return out;
}

export function readCapabilityKinds(root) {
  try {
    const text = readFileSync(path.join(root, "src", "lib", "types.ts"), "utf8");
    const block = text.match(/export const capabilityKinds = \[([\s\S]*?)\] as const/);
    if (!block) return null;
    const kinds = [...block[1].matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
    return kinds.length ? new Set(kinds) : null;
  } catch { return null; }
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
export function parseSsListeners(text) {
  return text.split("\n").map((line) => {
    const cols = line.trim().split(/\s+/);
    // ss -tlnpH: State Recv-Q Send-Q LocalAddress:Port PeerAddress:Port Process.
    // Match the local address column, never the numeric queue columns.
    const port = cols[3]?.match(/:(\d+)$/);
    if (!port) return null;
    const pid = line.match(/pid=(\d+)/);
    const cmd = line.match(/users:\(\("([^"]+)"/);
    return { port: Number(port[1]), pid: pid ? Number(pid[1]) : null, command: cmd ? cmd[1] : null };
  }).filter(Boolean);
}

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
    return parseSsListeners(ss);
  }
  return [];
}

// lsof reports only the short process name ("node"), which cannot tell the
// scheduler daemon apart from a squatter. Some legitimate Garrison processes
// (the scheduler) register nowhere at all, so identity has to come from the
// command line. One exec for every pid we care about, never one per pid.
export async function readProcessCommands(pids) {
  const wanted = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  if (!wanted.length) return new Map();
  const out = await execOut("ps", ["-p", wanted.join(","), "-o", "pid=,command="]);
  const map = new Map();
  for (const line of (out || "").split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
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

// Gateways hold a port but write NO ui-fittings status file — they register in
// ~/.garrison/gateway-pids/<composition>-<port>.json instead. Without this the
// port check reads the running gateway as an unknown squatter on 5777.
export function readGatewayRecords() {
  const out = [];
  const dir = path.join(GARRISON_HOME, "gateway-pids");
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const data = readJson(path.join(dir, name));
    if (data && data.fittingId && data.port) out.push({ fittingId: data.fittingId, port: Number(data.port), pid: data.pid ?? null });
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
