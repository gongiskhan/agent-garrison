#!/usr/bin/env node
// Jarvis channel backend — an optional voice HUD alongside Conversations.
//
// Talks to the Operative through the http-gateway:
//   - POST /api/chat   → proxies gateway POST /chat/stream (SSE)
//   - GET  /api/stream → proxies gateway GET  /channels/jarvis/stream (SSE)
// Also serves a static React bundle from dist/.
//
// LAN bind: default 127.0.0.1 (mirrors CLAUDE.md "talks only to localhost").
// User opts into 0.0.0.0 via config_schema.bind_host when they want phone access.

import { execFile } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { promisify } from "node:util";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { WebSocketServer } from "ws";
import { deriveStatusLine, rankAndCapCards } from "./kanban-status.mjs";
import { readInstanceState, scheduleInstanceWrite, flushInstanceWrites } from "./view-state.mjs";
import { RequestError, originAllowed, validatePost, readBody, proxyResponse, fetchJson, jsonRes } from "./http-transport.mjs";
import { createVoiceClient, relayVoiceStream } from "./voice-client.mjs";

// Mirrors garrisonDir() in src/lib/claude-home.ts: GARRISON_HOME (when set)
// IS the .garrison root, else ~/.garrison. Sandboxed runs (spike drivers) set
// it so their spawned instances never touch the live install's status files;
// voice/monitor discovery below reads the same root, so a sandboxed voice
// instance is still found by a sandboxed web-channel.
function garrisonDir() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

const STATUS_ROOT = path.join(garrisonDir(), "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "jarvis-os.json");
const MONITOR_STATUS_FILE = path.join(STATUS_ROOT, "monitor-default.json");
// Kanban Loop discovery: the HUD's Tasks panel mirrors the board and creates
// cards by reaching the kanban-loop Fitting server-to-server (its own port,
// discovered here — not hardcoded, since its port is configurable).
const KANBAN_STATUS_FILE = path.join(STATUS_ROOT, "kanban-loop.json");
// WhatsApp discovery: the HUD's send/received confirmation pulse subscribes to
// the whatsapp-web Fitting's live message SSE, discovered here (its port is
// configurable, never hardcoded). Absent = no pulse, the HUD degrades quietly.
const WHATSAPP_STATUS_FILE = path.join(STATUS_ROOT, "whatsapp-web.json");
// Connector CLIs (spotify/google/trello): sibling fittings when installed under
// apm_modules/_local, seed paths in dev. Connectors self-resolve their tokens
// via Garrison's auth-env route (internal token) — no secrets pass through
// this server.
const HERE_DIR = path.dirname(url.fileURLToPath(import.meta.url));
function connectorCandidates(name) {
  return [
    path.resolve(HERE_DIR, "..", "..", name, "scripts", "connector.mjs"),
    path.resolve(HERE_DIR, "..", "..", "..", "..", "..", "fittings", "seed", name, "scripts", "connector.mjs")
  ];
}
const SPOTIFY_CONNECTOR_CANDIDATES = connectorCandidates("spotify");
// Dev-env discovery: the HUD's session switcher lists / creates / commands the
// real multi-session engine (the dev-env Fitting, FITTING_ID "dev-env" →
// dev-env.json). The switcher talks to it server-to-server so a browser never
// needs to cross-origin to 7086 and each session's Claude PTY stays independent
// (commanding one never interrupts another). Absent = the switcher hides.
const DEVENV_STATUS_FILE = path.join(STATUS_ROOT, "dev-env.json");

const CHANNEL_ID = "jarvis";

// Composition config arrives from Garrison's own-port runner NAMESPACED:
// GARRISON_<ID>_<KEY> — the fitting id stripped of every non-alphanumeric, the
// config_schema key's separators normalised to "_", both upper-cased (see
// ownPortConfigEnv in src/lib/own-port-lifecycle.ts, which is the authority).
// jarvis-os + `vad_redemption_ms` → GARRISON_JARVISOS_VAD_REDEMPTION_MS. Bare
// names are NOT delivered any more. The runner-injected GARRISON_* env
// (GATEWAY_URL, DEVENV_URL, GATEWAY_HOST/PORT, COMPOSITION_ID, HOME) is not
// composition config and keeps its own names.
const cfg = (key) => process.env[`GARRISON_JARVISOS_${key}`];

export function parseArgs(argv = []) {
  const out = {
    port: Number(cfg("PORT") || 8082),
    host: cfg("BIND_HOST") || "127.0.0.1",
    // config_schema `gateway_url` overrides; else the runner-injected gateway.
    gatewayUrl: cfg("GATEWAY_URL") || process.env.GARRISON_GATEWAY_URL || "",
    devEnvUrl: process.env.GARRISON_DEVENV_URL || "",
    appUrl: process.env.GARRISON_APP_URL || "",
    tlsCert: cfg("TLS_CERT") || "",
    tlsKey: cfg("TLS_KEY") || ""
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--gateway-url") out.gatewayUrl = argv[++i];
    else if (a === "--dev-env-url") out.devEnvUrl = argv[++i];
    else if (a === "--tls-cert") out.tlsCert = argv[++i];
    else if (a === "--tls-key") out.tlsKey = argv[++i];
  }
  if (!out.gatewayUrl) {
    const h = process.env.GARRISON_GATEWAY_HOST || "127.0.0.1";
    const p = process.env.GARRISON_GATEWAY_PORT;
    if (p) out.gatewayUrl = `http://${h}:${p}`;
  }
  return out;
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, port: req.socket.localPort, pid: process.pid, host: opts.host });
}

async function handleMonitor(req, res) {
  if (!existsSync(MONITOR_STATUS_FILE)) {
    jsonRes(res, 200, { available: false });
    return;
  }
  let info;
  try {
    info = JSON.parse(readFileSync(MONITOR_STATUS_FILE, "utf8"));
  } catch {
    jsonRes(res, 200, { available: false });
    return;
  }
  if (!info?.url) {
    jsonRes(res, 200, { available: false });
    return;
  }
  const ok = await pingHealth(info.url, 500);
  if (!ok) {
    jsonRes(res, 200, { available: false });
    return;
  }
  jsonRes(res, 200, { available: true, url: info.url, tailnetUrl: (await tailnetServeMap())[Number(new URL(info.url).port)] || null });
}

async function pingHealth(baseUrl, timeoutMs) {
  return (await fetchJson(baseUrl, "/health", timeoutMs))?.ok === true;
}

// Smart-endpointing config for the HUD, projected from the composition
// (config_schema keys → UPPER_SNAKE env by the runner/eager-boot). The HUD
// fetches this once per session; the defaults here must match EP_DEFAULTS in
// ui/main.tsx so an unconfigured composition behaves identically either way.
function handleEndpointing(res) {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  // bargein_confirm_ms accepts 0 (= barge-in disabled), so it gets its own parser.
  const num0 = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const prob = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= 1 ? n : d;
  };
  jsonRes(res, 200, {
    redemptionMs: num(cfg("VAD_REDEMPTION_MS"), 550),
    minMs: num(cfg("ENDPOINT_MIN_MS"), 350),
    maxMs: num(cfg("ENDPOINT_MAX_MS"), 2600),
    bargeinProb: prob(cfg("BARGEIN_PROB"), 0.55),
    bargeinConfirmMs: num0(cfg("BARGEIN_CONFIRM_MS"), 350),
    // 0 disables the hands-free inactivity standby (session stays armed forever)
    idleTimeoutMs: num0(cfg("WAKE_IDLE_TIMEOUT_S"), 90) * 1000
  });
}

// ── HUD settings panel (gear icon → color picker + orb mode) ────────────────
// Persisted at ~/.garrison/view-state/jarvis-os/default.json via view-state.mjs
// (mirrors the dev-env Fitting's per-instance view-state convention — jarvis-os
// only ever has the one "default" instance, the always-mounted HUD). No save
// button: every change from the panel POSTs here and the on-disk write is
// debounced (scheduleInstanceWrite, ~500ms trailing). the settings store is
// the in-memory mirror the debounced writer reads from, and what GET answers
// from once warm — avoids a disk read on every poll.
// orbMode/orbCorner (Phase 3): the "shrink into a corner" preference and its
// last-dragged-to corner, read by both the HUD (ui/main.tsx, to decide whether
// to render transparent+chromeless) and the Garrison shell
// (JarvisPersistentFrame.tsx, told via postMessage — it never reads this file
// directly, cross-origin GETs from the browser would need CORS this endpoint
// doesn't grant).
const HUD_SETTINGS_FITTING = "jarvis-os";
const HUD_SETTINGS_INSTANCE = "default";
const ORB_CORNERS = new Set(["top-left", "top-right", "bottom-left", "bottom-right"]);
const DEFAULT_HUD_SETTINGS = {
  color: "#c8322c", // matches ui/hud-color.ts DEFAULT_HUD_COLOR
  orbMode: false,
  orbCorner: "bottom-right", // matches ui/orb-settings.ts DEFAULT_ORB_CORNER
  // Per-state orb colours — matches ui/core-colors.ts DEFAULT_STATE_COLORS
  // (listening cyan · thinking magenta · speaking near-white blue).
  stateColors: {
    listening: "#10ddf9",
    thinking: "#f91fbc",
    speaking: "#bccde6"
  }
};

const CORE_STATE_KEYS = ["listening", "thinking", "speaking"];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function settingsStore(deps) {
  return { value: null, loading: null, read: deps.readSettings || (() => readInstanceState(HUD_SETTINGS_FITTING, HUD_SETTINGS_INSTANCE)),
    write: deps.writeSettings || ((factory) => scheduleInstanceWrite(HUD_SETTINGS_FITTING, HUD_SETTINGS_INSTANCE, factory)) };
}
async function loadSettings(store) {
  if (store.value) return store.value;
  if (!store.loading) store.loading = Promise.resolve().then(store.read).then(({ exists, state }) => {
    const saved = exists && state && typeof state === "object" ? state : {};
    store.value = { ...DEFAULT_HUD_SETTINGS, ...saved,
      stateColors: { ...DEFAULT_HUD_SETTINGS.stateColors, ...(saved.stateColors || {}) } };
    return store.value;
  }).finally(() => { store.loading = null; });
  return store.loading;
}
async function handleHudSettingsGet(res, store) { jsonRes(res, 200, await loadSettings(store)); }

// Partial-update body: any subset of {color, orbMode, orbCorner, stateColors}.
// Each recognized field is validated independently and merged onto whatever is
// already known; a body with no recognized field is a 400 (most likely a
// caller bug, not a real "clear settings" request — there is no such thing).
async function handleHudSettingsPost(req, res, store) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { jsonRes(res, 400, { error: `invalid json: ${err.message}` }); return; }
  await loadSettings(store);
  const next = { ...store.value };
  let touched = false;
  if (body && typeof body === "object") {
    if (typeof body.color === "string") {
      const color = body.color.trim();
      if (!HEX_COLOR_RE.test(color)) { jsonRes(res, 400, { error: "color must be a #rrggbb hex string" }); return; }
      next.color = color;
      touched = true;
    }
    if (typeof body.orbMode === "boolean") {
      next.orbMode = body.orbMode;
      touched = true;
    }
    // stateColors is merged key-by-key rather than replaced wholesale: a client
    // that only knows about two of the three states must not silently drop the
    // third back to its default.
    if (body.stateColors && typeof body.stateColors === "object") {
      const merged = { ...DEFAULT_HUD_SETTINGS.stateColors, ...(next.stateColors || {}) };
      for (const key of CORE_STATE_KEYS) {
        const value = body.stateColors[key];
        if (value === undefined) continue;
        if (typeof value !== "string" || !HEX_COLOR_RE.test(value.trim())) {
          jsonRes(res, 400, { error: `stateColors.${key} must be a #rrggbb hex string` });
          return;
        }
        merged[key] = value.trim().toLowerCase();
      }
      next.stateColors = merged;
      touched = true;
    }
    if (typeof body.orbCorner === "string") {
      if (!ORB_CORNERS.has(body.orbCorner)) {
        jsonRes(res, 400, { error: "orbCorner must be one of top-left/top-right/bottom-left/bottom-right" });
        return;
      }
      next.orbCorner = body.orbCorner;
      touched = true;
    }
  }
  if (!touched) { jsonRes(res, 400, { error: "no recognized field (color/orbMode/orbCorner) in body" }); return; }
  store.value = next;
  await store.write(() => store.value);
  jsonRes(res, 200, store.value);
}

// ── workspace panel data ─────────────────────────────────────────────────────
// Read-only project state (git branch/commits + GitHub PRs via `gh`) for the
// HUD's Workspace panel. Everything here only READS the repo — no fetch, no
// checkout, and never a branch creation. A short in-memory cache keeps several
// polling HUD tabs from spawning git once each per tick.

const execFileP = promisify(execFile);
const PROJECT_TTL_MS = 15_000;
let projectCache = { at: 0, data: null };

async function runRead(cmd, args, cwd, timeout = 4000) {
  const { stdout } = await execFileP(cmd, args, { cwd, timeout, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

// ── active-project ("workspace target") resolution ───────────────────────────
// The WORKSPACE panel must reflect the repo where DEV WORK is actually
// happening — development sessions may run outside this checkout — instead of the
// agent-garrison repo the HUD server itself lives in. Precedence:
//   1. a running dev session's cwd (auto-follow), EXCLUDING sessions whose repo
//      is this server's own repo (a general session may have no base_path so
//      their cwd is the composition dir = agent-garrison — following those would
//      re-point the panel at Jarvis itself, the exact thing we're fixing).
//   2. the last project we followed (persisted), so the panel doesn't blank the
//      moment a session ends.
//   3. PROJECT_ROOT env (the static config override), if set.
//   4. nothing — a calm empty state. We NEVER fall back to the server's own repo.
// Runtime skills and commands are read from the projected configuration roots.
const WORKSPACE_STATE_FILE = path.join(STATUS_ROOT, "jarvis-os-workspace.json");
const WORKSPACE_TTL_MS = 8_000;
let workspaceCache = { at: 0, data: null };
let selfRootCache; // undefined = unresolved; string|null once computed

async function resolveSelfRoot() {
  if (selfRootCache !== undefined) return selfRootCache;
  try { selfRootCache = await runRead("git", ["rev-parse", "--show-toplevel"], process.cwd()); }
  catch { selfRootCache = null; }
  return selfRootCache;
}

async function persistWorkspace(root) {
  try {
    await mkdir(STATUS_ROOT, { recursive: true });
    await writeFile(WORKSPACE_STATE_FILE, JSON.stringify(
      { root, name: path.basename(root), updatedAt: new Date().toISOString() }, null, 2
    ));
  } catch { /* best-effort — a failed persist just means no "last project" fallback */ }
}

function readPersistedWorkspace() {
  try { return JSON.parse(readFileSync(WORKSPACE_STATE_FILE, "utf8"))?.root || null; }
  catch { return null; }
}

// Canonical activity is ISO text; tolerate legacy millisecond timestamps.
function sessionRecency(s) {
  const v = s?.lastActivityAt ?? s?.startedAt ?? s?.last_summary_at;
  if (typeof v === "number") return v;
  if (typeof v === "string") { const n = Date.parse(v); return Number.isNaN(n) ? 0 : n; }
  return 0;
}

export async function findLocalWorkingWorkspace(mesh, selfRoot, { repoRoot = (cwd) => runRead("git", ["rev-parse", "--show-toplevel"], cwd),
  pathExists = existsSync, canonicalPath = realpath } = {}) {
  if (!mesh?.self || !("node" in mesh.self)) return null;
  const rows = (Array.isArray(mesh.rows) ? mesh.rows : []).filter((row) =>
    row?.node === mesh.self.node && row.status === "working" && typeof row.cwd === "string" && path.isAbsolute(row.cwd))
    .sort((a, b) => sessionRecency(b) - sessionRecency(a));
  let canonicalSelf = selfRoot;
  try { if (selfRoot) canonicalSelf = await canonicalPath(selfRoot); } catch {}
  for (const row of rows) {
    // Remote rows are filtered before even testing a path on this filesystem.
    if (!pathExists(row.cwd)) continue;
    try {
      const top = await repoRoot(row.cwd);
      if (typeof top !== "string" || !path.isAbsolute(top)) continue;
      const canonical = await canonicalPath(top);
      if (canonical !== canonicalSelf) return canonical;
    } catch { /* not a readable local repository */ }
  }
  return null;
}

async function computeWorkspaceRoot(opts) {
  const selfRoot = await resolveSelfRoot();
  const mesh = await fetchJson(opts.appUrl || process.env.GARRISON_APP_URL || "", "/api/sessions", 8000, 4 * 1024 * 1024);
  const working = await findLocalWorkingWorkspace(mesh, selfRoot);
  if (working) { await persistWorkspace(working); return { root: working, source: "session" }; }
  // 2. last followed project
  const last = readPersistedWorkspace();
  if (last && existsSync(last)) return { root: last, source: "last" };
  // 3. explicit static override
  const fromEnv = cfg("PROJECT_ROOT")?.trim();
  if (fromEnv && existsSync(fromEnv)) return { root: fromEnv, source: "env" };
  // 4. no active project — do NOT fall back to this server's own repo
  return { root: null, source: "none" };
}

async function resolveWorkspaceRoot(opts) {
  const now = Date.now();
  if (workspaceCache.data && now - workspaceCache.at < WORKSPACE_TTL_MS) return workspaceCache.data;
  const data = await computeWorkspaceRoot(opts);
  workspaceCache = { at: now, data };
  return data;
}

// git@github.com:o/r.git / https://github.com/o/r.git → https://github.com/o/r
// (for commit/branch links in the HUD). Non-GitHub remotes pass through best-effort.
function webRemoteUrl(remote) {
  if (!remote) return null;
  return remote
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "") || null;
}

async function handleProject(res, opts) {
  const now = Date.now();
  if (projectCache.data && now - projectCache.at < PROJECT_TTL_MS) {
    jsonRes(res, 200, projectCache.data);
    return;
  }
  const ws = await resolveWorkspaceRoot(opts);
  const root = ws.root;
  if (!root) {
    // No cache: while idle we cheaply re-check each poll (workspace lookup is
    // itself cached ~8s) so the panel lights up promptly when a session starts.
    jsonRes(res, 200, { available: false, activeSource: ws.source });
    return;
  }
  // Each probe is independent and best-effort: a missing upstream or a flaky
  // `gh` (network, rate-limit) must not blank the whole panel.
  const [branch, counts, log, remote, branches, status, prsRaw] = await Promise.allSettled([
    runRead("git", ["rev-parse", "--abbrev-ref", "HEAD"], root),
    runRead("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], root),
    runRead("git", ["log", "-n", "4", "--format=%h%x1f%s%x1f%cr%x1f%an"], root),
    runRead("git", ["remote", "get-url", "origin"], root),
    runRead("git", ["for-each-ref", "--sort=-committerdate", "--count=6", "--format=%(refname:short)", "refs/heads"], root),
    // one porcelain line per changed/untracked file → uncommitted-change count
    runRead("git", ["status", "--porcelain"], root),
    // gh talks to the network — longer timeout, and failure just means prs: [].
    runRead("gh", ["pr", "list", "--limit", "8", "--json", "number,title,state,url,headRefName"], root, 6000)
  ]);
  const val = (r) => (r.status === "fulfilled" ? r.value : "");
  const [behindStr, aheadStr] = val(counts).split(/\s+/); // left=upstream-only (behind), right=HEAD-only (ahead)
  const commits = val(log)
    ? val(log).split("\n").map((line) => {
        const [hash, subject, when, author] = line.split("\x1f");
        return { hash, subject, when, author };
      })
    : [];
  let prs = [];
  try {
    const parsed = JSON.parse(val(prsRaw) || "[]");
    if (Array.isArray(parsed)) {
      prs = parsed.map((p) => ({
        number: p.number, title: p.title, state: p.state, url: p.url, branch: p.headRefName
      }));
    }
  } catch { /* gh output unusable → no PRs */ }
  const data = {
    available: true,
    root,
    name: path.basename(root),
    activeSource: ws.source,
    branch: val(branch) || null,
    ahead: aheadStr !== undefined ? Number(aheadStr) : null,
    behind: behindStr !== undefined && aheadStr !== undefined ? Number(behindStr) : null,
    remoteUrl: webRemoteUrl(val(remote)),
    commits,
    prs,
    branches: val(branches) ? val(branches).split("\n") : [],
    changed: val(status) ? val(status).split("\n").filter(Boolean).length : 0
  };
  projectCache = { at: now, data };
  jsonRes(res, 200, data);
}

// The working-tree diff (staged + unstaged vs HEAD) for the HUD's "view diff"
// action. Fetched on demand (not polled — a diff can be large), read-only,
// capped so a huge diff can't blow the response. Untracked files aren't in
// `git diff HEAD`; the panel's change count (from `git status`) still reflects
// them so the two never silently disagree about "something changed".
const DIFF_MAX = 120_000;
async function handleDiff(res, opts) {
  const root = (await resolveWorkspaceRoot(opts)).root;
  if (!root) { jsonRes(res, 200, { available: false }); return; }
  try {
    const patch = await runRead("git", ["diff", "HEAD"], root, 6000);
    const truncated = patch.length > DIFF_MAX;
    jsonRes(res, 200, { available: true, patch: truncated ? patch.slice(0, DIFF_MAX) : patch, truncated });
  } catch (e) {
    jsonRes(res, 200, { available: true, patch: "", error: String(e?.message || e) });
  }
}

async function handleRuntime(res, opts) {
  const [gateway, voice] = await Promise.all([fetchJson(opts.gatewayUrl, "/health"), opts.voice.capabilities()]);
  const roots = opts.configRoots || [process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    ...(process.env.GARRISON_COMPOSITION_DIR ? [path.join(process.env.GARRISON_COMPOSITION_DIR, ".claude")] : [])];
  const names = async (kind) => [...new Set((await Promise.all(roots.map(async (root) => {
    try { return (await readdir(path.join(root, kind), { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith(".") && (kind === "skills" ? entry.isDirectory() || entry.isSymbolicLink() : entry.isFile() && entry.name.endsWith(".md")))
      .map((entry) => kind === "commands" ? entry.name.slice(0, -3) : entry.name); }
    catch { return []; }
  }))).flat())].sort();
  const [skills, commands] = await Promise.all([names("skills"), names("commands")]);
  jsonRes(res, 200, { gateway: gateway?.ok ? { ok: true, mode: gateway.mode ?? null,
    uptimeMs: gateway.uptime_ms ?? null, sessions: gateway.sessions_count ?? null,
    channels: gateway.channels_count ?? null } : { ok: false }, voice, skills, commands });
}

// ── kanban panel data ────────────────────────────────────────────────────────
// Read-only board mirror + a create-card proxy for the HUD's Tasks panel. Jarvis
// reaches the kanban-loop Fitting server-to-server: that server binds loopback
// and closes CORS, but a Node request carries no Origin header, so both GET /board
// and POST /cards are allowed (kanban's originAllowed() passes when Origin is
// absent). A browser cross-origin call would be rejected — hence this proxy.
const KANBAN_TTL_MS = 8_000;
// A negative result (kanban momentarily unreachable) is cached only briefly, so a
// transient hiccup doesn't blank the Tasks panel for a full 8s after it recovers.
const KANBAN_NEG_TTL_MS = 1_500;
let kanbanCache = { expires: 0, data: null };

function readFittingInfo(file) {
  if (!existsSync(file)) return null;
  try {
    const info = JSON.parse(readFileSync(file, "utf8"));
    return info?.url ? info : null;
  } catch { return null; }
}

// Maps each `tailscale serve`-proxied loopback port to its HTTPS tailnet URL, so
// the HUD can hand the browser a reachable card link when reached over Tailscale
// (a loopback link is unreachable + mixed-content-blocked off-box). Mirrors
// src/lib/tailnet-serve.ts. Empty object when Tailscale isn't serving.
const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
];
const TAILNET_TTL_MS = 10_000;
let tailnetCache = { at: 0, map: null };

async function tailnetServeMap() {
  const now = Date.now();
  if (tailnetCache.map && now - tailnetCache.at < TAILNET_TTL_MS) return tailnetCache.map;
  const map = {};
  for (const bin of TAILSCALE_CANDIDATES) {
    try {
      let stdout;
      try {
        ({ stdout } = await execFileP(bin, ["serve", "status", "--json"], { timeout: 4000, maxBuffer: 1024 * 1024 }));
      } catch (err) {
        // The CLI prints a version-skew warning to stderr and can exit non-zero
        // while still emitting valid JSON on stdout — prefer that over throwing.
        if (typeof err?.stdout === "string" && err.stdout.includes("{")) stdout = err.stdout;
        else throw err;
      }
      const raw = stdout.slice(stdout.indexOf("{"));
      const status = JSON.parse(raw);
      for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
        const proxy = web?.Handlers?.["/"]?.Proxy;
        const m = proxy && /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(proxy);
        if (!m) continue;
        const localPort = Number(m[1]);
        if (Number.isFinite(localPort) && !(localPort in map)) map[localPort] = `https://${hostPort}`;
      }
      break; // first candidate that produced JSON wins
    } catch { /* try the next candidate path */ }
  }
  tailnetCache = { at: now, map };
  return map;
}

// deriveStatusLine + timeAgo live in ./kanban-status.mjs (pure + unit-tested).

// ── spotify now-playing (HUD music widget) ──────────────────────────────────
// GET /api/music → { available, is_playing, track, artist, album, art, … }.
// POST /api/music/cmd {action} → pause/resume/next/previous (whitelist).
// 8s cache: the widget polls; an unconnected/absent spotify is a cheap
// { available:false } (negative cache 30s), never an error to the HUD.
let musicCache = { expires: 0, data: null };
const MUSIC_TTL_MS = 8_000;
const MUSIC_NEG_TTL_MS = 30_000;
const MUSIC_CMDS = new Set(["pause", "resume", "next", "previous"]);

function spotifyConnectorPath() {
  for (const p of SPOTIFY_CONNECTOR_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

async function spotifyCall(action) {
  const cli = spotifyConnectorPath();
  if (!cli) return null;
  try {
    const { stdout } = await execFileP(process.execPath, [cli, "call", action], { timeout: 8000, maxBuffer: 256 * 1024 });
    const out = JSON.parse(stdout);
    return out?.ok ? out.result : null;
  } catch {
    return null;
  }
}

async function handleMusic(res) {
  const now = Date.now();
  if (musicCache.data && now < musicCache.expires) { jsonRes(res, 200, musicCache.data); return; }
  const cur = await spotifyCall("current");
  const data = cur ? { available: true, ...cur } : { available: false };
  musicCache = { expires: now + (cur ? MUSIC_TTL_MS : MUSIC_NEG_TTL_MS), data };
  jsonRes(res, 200, data);
}

async function handleMusicCmd(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { jsonRes(res, 400, { error: "invalid json" }); return; }
  const action = String(body?.action || "");
  if (!MUSIC_CMDS.has(action)) { jsonRes(res, 400, { error: "unknown action" }); return; }
  const result = await spotifyCall(action);
  musicCache = { expires: 0, data: null }; // bust — the widget refetches state
  jsonRes(res, result ? 200 : 502, result ?? { error: "spotify unavailable" });
}

// ── ambient mode data (/api/ambient) ─────────────────────────────────────────
// One aggregate for the idle smart-display: weather (Open-Meteo, keyless) +
// today/tomorrow agenda (google connector) + inbox (gmail) + personal Trello
// board. Sections are independent and fail-soft (null = card hidden); each has
// its own TTL so a dead connector never blanks the clock or the weather.
const ambientCache = {
  weather: { expires: 0, data: null, ttl: 15 * 60_000 },
  agenda: { expires: 0, data: null, ttl: 5 * 60_000 },
  emails: { expires: 0, data: null, ttl: 5 * 60_000 },
  board: { expires: 0, data: null, ttl: 5 * 60_000 }
};

async function connectorCall(name, action, args) {
  const cli = connectorCandidates(name).find((p) => existsSync(p));
  if (!cli) return null;
  try {
    const argv = [cli, "call", action];
    if (args !== undefined) argv.push(JSON.stringify(args));
    const { stdout } = await execFileP(process.execPath, argv, { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const out = JSON.parse(stdout);
    return out?.ok ? out.result : null;
  } catch {
    return null;
  }
}

// Lisbon calendar-day boundary as a Date, offset by `plusDays`.
function lisbonDayStart(plusDays = 0) {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(now); // YYYY-MM-DD
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + plusDays);
  return d;
}

async function ambientWeather() {
  const u = "https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.14" +
    "&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code" +
    "&timezone=Europe%2FLisbon&forecast_days=2";
  const j = await fetchJson(u, u, 6000);
  if (!j) return null;
  return {
    temp: Math.round(j.current?.temperature_2m ?? NaN),
    code: j.current?.weather_code ?? null,
    today: { max: Math.round(j.daily?.temperature_2m_max?.[0] ?? NaN), min: Math.round(j.daily?.temperature_2m_min?.[0] ?? NaN), code: j.daily?.weather_code?.[0] ?? null },
    tomorrow: { max: Math.round(j.daily?.temperature_2m_max?.[1] ?? NaN), min: Math.round(j.daily?.temperature_2m_min?.[1] ?? NaN), code: j.daily?.weather_code?.[1] ?? null }
  };
}

async function ambientAgenda() {
  const start = lisbonDayStart(0);
  const endTomorrow = lisbonDayStart(2);
  const r = await connectorCall("google", "calendar.list_events", { time_min: start.toISOString(), max: 12 });
  if (!r || !Array.isArray(r.items)) return null;
  const tomorrowStart = lisbonDayStart(1);
  const events = [];
  for (const it of r.items) {
    const rawStart = it.start?.dateTime ?? (it.start?.date ? `${it.start.date}T00:00:00` : null);
    if (!rawStart) continue;
    const d = new Date(rawStart);
    if (d >= endTomorrow || d < start) continue; // only today + tomorrow
    events.push({
      when: d >= tomorrowStart ? "amanhã" : "hoje",
      time: it.start?.dateTime
        ? new Intl.DateTimeFormat("pt-PT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Lisbon" }).format(d)
        : "dia todo",
      title: it.summary || "(sem título)"
    });
    if (events.length >= 5) break;
  }
  return { events };
}

async function ambientEmails() {
  const r = await connectorCall("google", "gmail.list", { query: "in:inbox", max: 6 });
  if (!r || !Array.isArray(r.messages)) return null;
  const unread = r.messages.filter((m) => m.unread);
  const strip = (from) => String(from || "").replace(/<[^>]*>/g, "").replace(/"/g, "").trim();
  return {
    unread: unread.length,
    items: (unread.length ? unread : r.messages).slice(0, 3).map((m) => ({ from: strip(m.from), subject: m.subject, unread: Boolean(m.unread) }))
  };
}

async function ambientBoard() {
  const lists = await connectorCall("trello", "lists");
  if (!Array.isArray(lists)) return null;
  const wanted = lists.filter((l) => !/starter guide/i.test(l.name || "")).slice(0, 3);
  const columns = await Promise.all(wanted.map(async (l) => {
    const cards = await connectorCall("trello", "list_cards", { list_id: l.id });
    return { name: l.name, cards: (Array.isArray(cards) ? cards : []).slice(0, 5).map((c) => c.name) };
  }));
  return { columns };
}

async function ambientSection(key, fn) {
  const slot = ambientCache[key];
  const now = Date.now();
  if (now < slot.expires) return slot.data;
  let data = null;
  try { data = await fn(); } catch { data = null; }
  // negative results retry sooner (a connector mid-boot shouldn't blank 5 min)
  slot.data = data;
  slot.expires = now + (data ? slot.ttl : 60_000);
  return data;
}

async function handleAmbient(res) {
  const [weather, agenda, emails, board] = await Promise.all([
    ambientSection("weather", ambientWeather),
    ambientSection("agenda", ambientAgenda),
    ambientSection("emails", ambientEmails),
    ambientSection("board", ambientBoard)
  ]);
  jsonRes(res, 200, { weather, agenda, emails, board });
}

async function handleKanban(res) {
  const now = Date.now();
  if (kanbanCache.data && now < kanbanCache.expires) {
    jsonRes(res, 200, kanbanCache.data);
    return;
  }
  const cacheAndSend = (data, ttl = KANBAN_TTL_MS) => { kanbanCache = { expires: now + ttl, data }; jsonRes(res, 200, data); };
  const info = readFittingInfo(KANBAN_STATUS_FILE);
  if (!info?.url) { cacheAndSend({ available: false }, KANBAN_NEG_TTL_MS); return; }
  if (!(await pingHealth(info.url, 600))) { cacheAndSend({ available: false }, KANBAN_NEG_TTL_MS); return; }
  const board = await fetchJson(info.url, "/board", 3000);
  if (!board || !Array.isArray(board.cards)) { cacheAndSend({ available: false }, KANBAN_NEG_TTL_MS); return; }
  const listTitle = {};
  for (const l of board.lists || []) listTitle[l.id] = l.title;
  let cards = board.cards.map((c) => ({
    id: c.id,
    title: c.title,
    list: c.list,
    listTitle: listTitle[c.list] || c.list,
    status: c.status,
    statusLine: deriveStatusLine(c, listTitle[c.list] || c.list),
    runningSince: c.runningSince ?? null,
    updated: c.updated ?? null
  }));
  const counts = {
    total: cards.length,
    running: cards.filter((c) => c.status === "running").length,
    attention: cards.filter((c) => c.status === "needs-attention").length
  };
  // Surface running + needs-attention first, then most-recently-updated; cap 8.
  cards = rankAndCapCards(cards, 8);
  let tailnetUrl = null;
  try {
    const map = await tailnetServeMap();
    tailnetUrl = map[Number(new URL(info.url).port)] || null;
  } catch { /* no tailnet mapping — loopback link only */ }
  cacheAndSend({ available: true, boardUrl: info.url, tailnetUrl, counts, cards });
}

// POST proxy → kanban `POST /cards`. Server-to-server (no Origin) so the mutation
// guard passes. Busts the board cache so the new card shows on the next poll.
async function postJson(baseUrl, subpath, payload, res) {
  await proxyResponse(res, new URL(subpath, baseUrl), { method: "POST", body: payload,
    headers: { "Content-Type": "application/json" }, timeoutMs: 5000 });
  kanbanCache = { expires: 0, data: null };
}

// Advance/start a card (voice "avança o card X"). Proxies kanban POST /cards/:id/start.
function handleKanbanStart(res, id) {
  const info = readFittingInfo(KANBAN_STATUS_FILE);
  if (!info?.url) { jsonRes(res, 503, { error: "kanban-loop fitting not available" }); return; }
  return postJson(info.url, `/cards/${id}/start`, "{}", res);
}

async function handleKanbanCreate(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { jsonRes(res, 400, { error: `invalid json: ${err.message}` }); return; }
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  if (!title && !description) { jsonRes(res, 400, { error: "title or description required" }); return; }
  const info = readFittingInfo(KANBAN_STATUS_FILE);
  if (!info?.url) { jsonRes(res, 503, { error: "kanban-loop fitting not available" }); return; }
  const payload = JSON.stringify({
    ...(title ? { title } : {}),
    ...(description ? { description } : {})
  });
  return postJson(info.url, "/cards", payload, res);
}

// Thin GET proxy to the gateway for the Workspace panel's live lists
// (/sessions, /worktrees). Upstream errors — including the gateway's 502 when
// the dev-env worktrees proxy isn't stationed — degrade to the fallback body so
// the panel section simply omits itself instead of erroring.
async function handleSessions(res, opts) {
  const data = await fetchJson(opts.appUrl || process.env.GARRISON_APP_URL || "", "/api/sessions", 8000, 4 * 1024 * 1024);
  jsonRes(res, 200, data && Array.isArray(data.rows) && Array.isArray(data.nodes) ? data :
    { available: false, self: { node: null, accentColor: null }, nodes: [], rows: [] });
}

async function handleGatewayGet(req, res, opts, subpath, fallbackBody) {
  const data = await fetchJson(opts.gatewayUrl, subpath, 4000);
  jsonRes(res, 200, data ?? fallbackBody);
}

async function handleVoiceInfo(res, opts) { jsonRes(res, 200, await opts.voice.capabilities()); }
async function handleVoiceProxy(req, res, subpath, opts) { return opts.voice.proxy(req, res, subpath); }
async function handleVoiceTtsGet(req, res, opts) { return opts.voice.proxy(req, res, "/tts"); }

async function readJsonBody(req) {
  if (req.jarvisJson !== undefined) return req.jarvisJson;
  const value = JSON.parse((await readBody(req, { limit: 256 * 1024 })).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError(400, "JSON object required");
  return value;
}
function pipeUpstreamSse(req, res, upstreamOpts, upstreamBody) {
  const target = new URL(`${upstreamOpts.protocol || "http:"}//${upstreamOpts.hostname}${upstreamOpts.port ? `:${upstreamOpts.port}` : ""}${upstreamOpts.path}`);
  return proxyResponse(res, target, { ...upstreamOpts, body: upstreamBody,
    sse: true, timeoutMs: 30 * 60_000, maxBytes: 64 * 1024 * 1024 });
}

function handleStream(req, res, opts) {
  // live=1: the voice UI speaks each session reply as it lands, so it must NOT get
  // the ring-buffer replay (no re-speaking old replies on connect/reconnect).
  const target = new URL(`/channels/${CHANNEL_ID}/stream?live=1`, opts.gatewayUrl);
  return pipeUpstreamSse(req, res, {
    method: "GET",
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: target.pathname + target.search, // keep ?live=1
    headers: { Accept: "text/event-stream" }
  });
}

// WhatsApp live message stream: proxy /api/whatsapp/events → whatsapp-web's
// /events SSE (server-to-server; the daemon is loopback-only, a browser can't
// reach it directly). Absent Fitting → an immediately-closed empty stream so
// the client's EventSource simply never fires (and its own retry backs off).
function handleWhatsappEvents(req, res) {
  const info = readFittingInfo(WHATSAPP_STATUS_FILE);
  if (!info?.url) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.end();
    return;
  }
  let target;
  try { target = new URL("/events", info.url); }
  catch { res.statusCode = 200; res.setHeader("Content-Type", "text/event-stream"); res.end(); return; }
  return pipeUpstreamSse(req, res, {
    method: "GET",
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    headers: { Accept: "text/event-stream" }
  });
}

// Rich chat surface: proxy /api/claude/* to the gateway's /claude/*. The SSE
// stream uses pipeUpstreamSse; the JSON actions buffer + forward.
function handleClaudeStream(req, res, opts) {
  const target = new URL("/claude/stream", opts.gatewayUrl);
  return pipeUpstreamSse(req, res, {
    method: "GET",
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    headers: { Accept: "text/event-stream" }
  });
}

async function handleClaudeProxy(req, res, opts, subpath, method) {
  const payload = method === "POST" ? JSON.stringify(await readJsonBody(req)) : undefined;
  return proxyResponse(res, new URL(`/claude/${subpath}`, opts.gatewayUrl), {
    method, body: payload, headers: { Accept: "application/json", "Content-Type": "application/json" }, timeoutMs: 15_000 });
}

async function handleChat(req, res, opts) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonRes(res, 400, { error: `invalid json: ${err.message}` });
    return;
  }
  const message = typeof body?.message === "string" ? body.message : "";
  if (!message.trim()) {
    jsonRes(res, 400, { error: "message is required" });
    return;
  }
  const payload = JSON.stringify({ message, channel: CHANNEL_ID });
  const target = new URL("/chat/stream", opts.gatewayUrl);
  return pipeUpstreamSse(req, res, {
    method: "POST",
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      Accept: "text/event-stream"
    }
  }, payload);
}

// ── dev-env session switcher ─────────────────────────────────────────────────
// The HUD's session switcher drives the dev-env Fitting's real multi-session
// engine (port 7086): list / create / command one session by id, and stream its
// reply. Server-to-server (loopback, no Origin header) so the browser never
// cross-origins to dev-env; commanding one session's Claude PTY never interrupts
// another's (they are independent, tmux-backed node-pty children).

// dev-env base URL: explicit --dev-env-url / env wins, else its status file, else
// null → the switcher hides (dev-env not stationed). Rediscovered each call so it
// survives a dev-env restart on a new port.
function readDevEnvUrl(opts) {
  if (opts?.devEnvUrl) return opts.devEnvUrl;
  return readFittingInfo(DEVENV_STATUS_FILE)?.url || null;
}

// Buffered JSON POST proxy to an arbitrary upstream (dev-env). Mirrors postJson
// but forwards a caller-built object and carries the upstream status through.
function proxyJson(res, baseUrl, subpath, method, payload, timeoutMs = 8000) {
  return proxyResponse(res, new URL(subpath, baseUrl), { method,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { Accept: "application/json", "Content-Type": "application/json" }, timeoutMs });
}

// GET /api/dev-sessions → dev-env GET /sessions, annotated with `available` so
// the HUD knows whether to show the switcher. Any failure degrades to an empty,
// unavailable list (the panel section simply omits itself).
async function handleDevSessions(req, res, opts) {
  const base = readDevEnvUrl(opts);
  if (!base) { jsonRes(res, 200, { available: false, sessions: [] }); return; }
  const data = await fetchJson(base, "/sessions", 3000);
  if (!data || !Array.isArray(data.sessions)) { jsonRes(res, 200, { available: false, sessions: [] }); return; }
  jsonRes(res, 200, { available: true, sessions: data.sessions });
}

// POST /api/dev-sessions → dev-env POST /sessions ("start session"). Defaults the
// project path to the active workspace root when the caller omits it, so "cria
// uma sessão" from the HUD lands in the project Jarvis is currently following.
async function handleDevCreate(req, res, opts) {
  const base = readDevEnvUrl(opts);
  if (!base) { jsonRes(res, 503, { error: "dev-env not available" }); return; }
  let body;
  try { body = await readJsonBody(req); } catch (err) { jsonRes(res, 400, { error: `invalid json: ${err.message}` }); return; }
  let projectPath = typeof body?.path === "string" && body.path.trim() ? body.path.trim() : "";
  if (!projectPath) projectPath = (await resolveWorkspaceRoot(opts)).root || "";
  if (!projectPath) { jsonRes(res, 400, { error: "no project path (workspace root unknown)" }); return; }
  const payload = {
    path: projectPath,
    ...(typeof body?.title === "string" && body.title.trim() ? { title: body.title.trim() } : {}),
    ...(typeof body?.mode === "string" ? { mode: body.mode } : {}),
    ...(body?.continue === true ? { continue: true } : {})
  };
  return proxyJson(res, base, "/sessions", "POST", payload, 20000);
}

// POST /api/dev-sessions/:id/instruct → dev-env /sessions/:id/instruct. Writes the
// text into THAT session's Claude PTY (two-phase text+Enter, handled dev-env side).
async function handleDevInstruct(req, res, opts, sessionId) {
  const base = readDevEnvUrl(opts);
  if (!base) { jsonRes(res, 503, { error: "dev-env not available" }); return; }
  let body;
  try { body = await readJsonBody(req); } catch (err) { jsonRes(res, 400, { error: `invalid json: ${err.message}` }); return; }
  const text = typeof body?.text === "string" ? body.text : typeof body?.message === "string" ? body.message : "";
  if (!text.trim()) { jsonRes(res, 400, { error: "text required" }); return; }
  const payload = { text, ...(Number.isFinite(body?.delayMs) ? { delayMs: body.delayMs } : {}) };
  return proxyJson(res, base, `/sessions/${encodeURIComponent(sessionId)}/instruct`, "POST", payload, 10000);
}

// GET /api/dev-sessions/:id/stream → dev-env /sessions/:id/claude/stream (rich SSE:
// hello / assistant {text} / turn {active} / status). The HUD mirrors the chosen
// session's live reply from this without touching the orchestrator.
function handleDevStream(req, res, opts, sessionId) {
  const base = readDevEnvUrl(opts);
  if (!base) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    try { res.write(`event: error\ndata: ${JSON.stringify({ message: "dev-env not available" })}\n\n`); } catch {}
    try { res.end(); } catch {}
    return;
  }
  const target = new URL(`/sessions/${encodeURIComponent(sessionId)}/claude/stream`, base);
  return pipeUpstreamSse(req, res, {
    method: "GET",
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    headers: { Accept: "text/event-stream" }
  });
}

// POST /api/dev-sessions/:id/interrupt → dev-env /sessions/:id/claude/interrupt
// (ESC into that session's PTY). Lets the HUD stop a runaway session by id.
function handleDevInterrupt(req, res, opts, sessionId) {
  const base = readDevEnvUrl(opts);
  if (!base) { jsonRes(res, 503, { error: "dev-env not available" }); return; }
  return proxyJson(res, base, `/sessions/${encodeURIComponent(sessionId)}/claude/interrupt`, "POST", {}, 5000);
}

async function serveStatic(req, res, distDir) {
  let pathname;
  try { pathname = decodeURIComponent(url.parse(req.url || "/").pathname || "/"); }
  catch { throw new RequestError(400, "invalid path"); }
  if (pathname.includes("\0")) throw new RequestError(400, "invalid path");
  let root;
  try { root = await realpath(distDir); } catch { throw new RequestError(404, "Jarvis view has not been built"); }
  let requested = path.resolve(root, pathname === "/" ? "index.html" : `.${pathname}`);
  if (!requested.startsWith(root + path.sep)) throw new RequestError(404, "not found");
  let file;
  try { file = await realpath(requested); }
  catch {
    if (path.extname(pathname)) throw new RequestError(404, "not found");
    file = await realpath(path.join(root, "index.html"));
  }
  if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) throw new RequestError(404, "not found");
  const ext = path.extname(file);
  const mime = { ".html": "text/html", ".js": "application/javascript", ".mjs": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".svg": "image/svg+xml", ".map": "application/json", ".wasm": "application/wasm", ".onnx": "application/octet-stream" };
  res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream", "Cache-Control": [".wasm", ".onnx"].includes(ext) ? "public, max-age=604800, immutable" : "no-cache" });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(file);
  stream.once("error", () => res.destroy());
  res.once("close", () => stream.destroy());
  stream.pipe(res);
}

export async function writeStatusFile(opts, { statusFile = STATUS_FILE, pid = process.pid } = {}) {
  await mkdir(path.dirname(statusFile), { recursive: true });
  const temporary = `${statusFile}.${pid}.${randomUUID()}.tmp`;
  const host = opts.host === "0.0.0.0" || opts.host === "::" ? "localhost" : opts.host;
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const record = { fittingId: "jarvis-os", port: opts.port, url: `${opts.scheme || "http"}://${address}:${opts.port}`,
    pid, startedAt: new Date().toISOString() };
  try { await writeFile(temporary, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 }); await rename(temporary, statusFile); }
  finally { await unlink(temporary).catch(() => {}); }
}
export async function clearStatusFile({ statusFile = STATUS_FILE, pid = process.pid } = {}) {
  try { if (JSON.parse(await readFile(statusFile, "utf8"))?.pid === pid) await unlink(statusFile); } catch {}
}

export function createRequestHandler(opts = parseArgs(), deps = {}) {
  const distDir = deps.distDir || path.resolve(HERE_DIR, "..", "dist");
  const liveOpts = { ...opts, configRoots: deps.configRoots,
    voice: deps.voice || createVoiceClient({ statusRoot: deps.statusRoot || STATUS_ROOT,
      fittingId: deps.voiceFittingId, token: deps.voiceToken, timeoutMs: deps.voiceTimeoutMs, maxResponseBytes: deps.voiceMaxResponseBytes }) };
  const settings = settingsStore(deps);
  let activeRequests = 0;
  return async (req, res) => {
    if (activeRequests >= (deps.maxRequests || 32)) { req.resume(); return jsonRes(res, 429, { error: "Jarvis request capacity reached" }); }
    activeRequests++;
    let released = false;
    const release = () => { if (!released) { released = true; activeRequests--; res.off("close", release); res.off("finish", release); } };
    res.once("close", release); res.once("finish", release);
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";
      if (!["GET", "HEAD", "POST"].includes(method)) throw new RequestError(405, "method not supported");
      if (method === "POST") {
        validatePost(req, pathname === "/api/voice/stt");
        const raw = await readBody(req, { limit: pathname === "/api/voice/stt" ? 8 * 1024 * 1024 : 256 * 1024, timeoutMs: deps.bodyTimeoutMs });
        req.jarvisRaw = raw;
        if (pathname !== "/api/voice/stt") {
          try { req.jarvisJson = JSON.parse(raw.toString("utf8")); } catch { throw new RequestError(400, "invalid JSON"); }
          if (!req.jarvisJson || typeof req.jarvisJson !== "object" || Array.isArray(req.jarvisJson)) throw new RequestError(400, "JSON object required");
        }
        if (req.aborted || res.destroyed) return;
      }
      if (pathname === "/api/voice/tts" && method === "GET" && !originAllowed(req)) throw new RequestError(403, "same-host Origin required");
      if ((pathname === "/api/chat" || pathname === "/api/stream" || pathname.startsWith("/api/claude/")) && !liveOpts.gatewayUrl) throw new RequestError(503, "gateway is not configured");
      if (method === "HEAD" && pathname.startsWith("/api/")) throw new RequestError(405, "method not supported");
      if (pathname === "/health" || pathname === "/api/health") return await handleHealth(req, res, liveOpts);
      if (pathname === "/api/monitor" && method === "GET") return await handleMonitor(req, res);
      if (pathname === "/api/voice" && method === "GET") return await handleVoiceInfo(res, liveOpts);
      if (pathname === "/api/endpointing" && method === "GET") return await handleEndpointing(res);
      if (pathname === "/api/project" && method === "GET") return await handleProject(res, liveOpts);
      if (pathname === "/api/diff" && method === "GET") return await handleDiff(res, liveOpts);
      if (pathname === "/api/ambient" && method === "GET") return await handleAmbient(res);
      if (pathname === "/api/ui-config" && method === "GET") return jsonRes(res, 200, { ambient_after_s: Math.max(0, Number(cfg("AMBIENT_AFTER_S") || 180) || 0), instanceProfile: ["node", "prod", "dev", "codex"].includes(process.env.GARRISON_INSTANCE_ID) ? process.env.GARRISON_INSTANCE_ID : "node" });
      if (pathname === "/api/hud-settings" && method === "GET") return await handleHudSettingsGet(res, settings);
      if (pathname === "/api/hud-settings" && method === "POST") return await handleHudSettingsPost(req, res, settings);
      if (pathname === "/api/music" && method === "GET") return await handleMusic(res);
      if (pathname === "/api/music/cmd" && method === "POST") return await handleMusicCmd(req, res);
      if (pathname === "/api/kanban" && method === "GET") return await handleKanban(res);
      if (pathname === "/api/kanban/cards" && method === "POST") return await handleKanbanCreate(req, res);
      const kbStart = pathname.match(/^\/api\/kanban\/cards\/([0-9A-HJKMNP-TV-Z]{26})\/start$/i);
      if (kbStart && method === "POST") return await handleKanbanStart(res, kbStart[1]);
      if (pathname === "/api/runtime" && method === "GET") return await handleRuntime(res, liveOpts);
      if (pathname === "/api/sessions" && method === "GET") return await handleSessions(res, liveOpts);
      // Real multi-session engine (dev-env) — the HUD's session switcher.
      if (pathname === "/api/dev-sessions" && method === "GET") return await handleDevSessions(req, res, liveOpts);
      if (pathname === "/api/dev-sessions" && method === "POST") return await handleDevCreate(req, res, liveOpts);
      {
        const m = pathname.match(/^\/api\/dev-sessions\/([^/]+)\/instruct$/);
        if (m && method === "POST") return await handleDevInstruct(req, res, liveOpts, decodeURIComponent(m[1]));
      }
      {
        const m = pathname.match(/^\/api\/dev-sessions\/([^/]+)\/stream$/);
        if (m && method === "GET") return await handleDevStream(req, res, liveOpts, decodeURIComponent(m[1]));
      }
      {
        const m = pathname.match(/^\/api\/dev-sessions\/([^/]+)\/interrupt$/);
        if (m && method === "POST") return await handleDevInterrupt(req, res, liveOpts, decodeURIComponent(m[1]));
      }
      if (pathname === "/api/worktrees" && method === "GET") {
        // Scope the worktrees list to the active project so it actually
        // populates (the gateway needs a ?project= repo path; without it the
        // dev-env proxy 400s and we degrade to the empty fallback).
        const wsRoot = (await resolveWorkspaceRoot(liveOpts)).root;
        const sub = wsRoot ? `/worktrees?project=${encodeURIComponent(wsRoot)}` : "/worktrees";
        return await handleGatewayGet(req, res, liveOpts, sub, { worktrees: [] });
      }
      if (pathname === "/api/voice/stt" && method === "POST") return await handleVoiceProxy(req, res, "/stt", liveOpts);
      if (pathname === "/api/voice/tts" && method === "POST") return await handleVoiceProxy(req, res, "/tts", liveOpts);
      if (pathname === "/api/voice/tts" && method === "GET") return await handleVoiceTtsGet(req, res, liveOpts);
      if (pathname === "/api/stream" && method === "GET") return await handleStream(req, res, liveOpts);
      if (pathname === "/api/whatsapp/events" && method === "GET") return await handleWhatsappEvents(req, res);
      if (pathname === "/api/chat" && method === "POST") return await handleChat(req, res, liveOpts);
      if (pathname === "/api/claude/stream" && method === "GET") return await handleClaudeStream(req, res, liveOpts);
      if (pathname === "/api/claude/status" && method === "GET") return await handleClaudeProxy(req, res, liveOpts, "status", "GET");
      if (pathname === "/api/claude/commands" && method === "GET") return await handleClaudeProxy(req, res, liveOpts, "commands", "GET");
      if (pathname === "/api/claude/message" && method === "POST") return await handleClaudeProxy(req, res, liveOpts, "message", "POST");
      if (pathname === "/api/claude/keys" && method === "POST") return await handleClaudeProxy(req, res, liveOpts, "keys", "POST");
      if (pathname === "/api/claude/mode" && method === "POST") return await handleClaudeProxy(req, res, liveOpts, "mode", "POST");
      if (pathname === "/api/claude/interrupt" && method === "POST") return await handleClaudeProxy(req, res, liveOpts, "interrupt", "POST");
      if (pathname.startsWith("/api/")) {
        jsonRes(res, 404, { error: "not found", path: pathname });
        return;
      }
      if (!["GET", "HEAD"].includes(method)) throw new RequestError(405, "method not supported");
      return await serveStatic(req, res, distDir);
    } catch (err) {
      req.resume();
      if (!(err instanceof RequestError)) console.error("[jarvis-os] handler failed:", err?.code || err?.name || "error");
      jsonRes(res, err instanceof RequestError ? err.status : 500, { error: err instanceof RequestError ? err.message : "request failed" });
    }
  };

}

export async function startServer(opts = parseArgs(process.argv.slice(2)), deps = {}) {
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error("invalid Jarvis port");
  let tls = null;
  if (opts.tlsCert || opts.tlsKey) {
    if (!opts.tlsCert || !opts.tlsKey) throw new Error("both TLS certificate and key are required");
    tls = { cert: await readFile(opts.tlsCert), key: await readFile(opts.tlsKey) };
  }
  const liveOpts = { ...opts, scheme: tls ? "https" : "http" };
  const voice = deps.voice || createVoiceClient({ statusRoot: deps.statusRoot || STATUS_ROOT,
    fittingId: deps.voiceFittingId, token: deps.voiceToken, timeoutMs: deps.voiceTimeoutMs });
  const handler = createRequestHandler(liveOpts, { ...deps, voice });
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const refuse = (status) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
    void (async () => {
      if (!originAllowed(request)) return refuse("403 Forbidden");
      const parsed = new URL(request.url || "/", "http://jarvis.invalid");
      const key = { "/api/voice/stream": "stream", "/api/voice/events": "wakeEvents" }[parsed.pathname];
      if (!key) return refuse("404 Not Found");
      const upstream = await voice.websocket(key);
      if (!upstream) return refuse("503 Service Unavailable");
      if (socket.destroyed) return;
      if (wss.clients.size >= 16) return refuse("503 Service Unavailable");
      wss.handleUpgrade(request, socket, head, (client) => relayVoiceStream(client, upstream, parsed.search));
    })().catch(() => refuse("502 Bad Gateway"));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(liveOpts.port, liveOpts.host, () => { server.off("error", reject); resolve(); });
  });
  liveOpts.port = server.address().port;
  const statusFile = deps.statusFile || STATUS_FILE;
  try { await writeStatusFile(liveOpts, { statusFile }); }
  catch (err) { await new Promise((resolve) => server.close(resolve)); throw err; }
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const timeout = setTimeout(() => process.exit(1), 3000); timeout.unref();
    for (const client of wss.clients) client.terminate();
    await flushInstanceWrites();
    await clearStatusFile({ statusFile });
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  const onSignal = () => { void shutdown(); };
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
  server.once("close", () => {
    process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
    for (const client of wss.clients) client.terminate();
    wss.close();
    void clearStatusFile({ statusFile });
  });
  console.log(`[jarvis-os] listening on ${liveOpts.scheme}://${liveOpts.host}:${liveOpts.port}`);
  return { server, options: liveOpts };
}

if (process.argv[1] && path.resolve(url.fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  startServer().catch((err) => { console.error("[jarvis-os] failed to start:", err.message); process.exit(1); });
}
