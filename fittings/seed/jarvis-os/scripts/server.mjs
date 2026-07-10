#!/usr/bin/env node
// Web-channel Fitting backend — mobile-first browser chat surface.
//
// Talks to the Operative through the http-gateway:
//   - POST /api/chat   → proxies gateway POST /chat/stream (SSE)
//   - GET  /api/stream → proxies gateway GET  /channels/web/stream (SSE)
// Also serves a static React bundle from dist/.
//
// LAN bind: default 127.0.0.1 (mirrors CLAUDE.md "talks only to localhost").
// User opts into 0.0.0.0 via config_schema.bind_host when they want phone access.

import { execFile } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { promisify } from "node:util";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { deriveStatusLine, rankAndCapCards } from "./kanban-status.mjs";

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
// Voice discovery: prefer the Local Voice Fitting, fall back to deepgram-voice.
// Either provides the same kind:voice contract (/stt, /tts); voice is a
// singleton so at most one is stationed.
const VOICE_STATUS_FILES = [
  path.join(STATUS_ROOT, "local-voice.json"),
  path.join(STATUS_ROOT, "deepgram-voice.json")
];
// Kanban Loop discovery: the HUD's Tasks panel mirrors the board and creates
// cards by reaching the kanban-loop Fitting server-to-server (its own port,
// discovered here — not hardcoded, since findFreePort may bump 7089).
const KANBAN_STATUS_FILE = path.join(STATUS_ROOT, "kanban-loop.json");
// Dev-env discovery: the HUD's session switcher lists / creates / commands the
// real multi-session engine (the dev-env Fitting, FITTING_ID "dev-env" →
// dev-env.json). The switcher talks to it server-to-server so a browser never
// needs to cross-origin to 7086 and each session's Claude PTY stays independent
// (commanding one never interrupts another). Absent = the switcher hides.
const DEVENV_STATUS_FILE = path.join(STATUS_ROOT, "dev-env.json");

// Reuse the proven "web" channel ring buffer on the gateway — the Jarvis HUD
// is an alternative front-end to the web channel, not a second concurrent one.
const CHANNEL_ID = "web";

function parseArgs(argv) {
  const out = {
    port: Number(process.env.JARVIS_PORT || 7092),
    host: process.env.JARVIS_HOST || "127.0.0.1",
    gatewayUrl: process.env.GARRISON_GATEWAY_URL || "",
    devEnvUrl: process.env.GARRISON_DEVENV_URL || "",
    tlsCert: process.env.JARVIS_TLS_CERT || "",
    tlsKey: process.env.JARVIS_TLS_KEY || ""
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
    const p = process.env.GARRISON_GATEWAY_PORT || "4777";
    out.gatewayUrl = `http://${h}:${p}`;
  }
  return out;
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// Cross-site WebSocket hijacking defense: allow a request with no Origin (native
// client), a loopback/tailnet Origin, or a same-host Origin; reject anything else
// (a page on evil.com). Tailnet (*.ts.net) is allowed so access via `tailscale
// serve` keeps working even though the proxy may rewrite the Host header.
function wsOriginAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    if (o.hostname === "127.0.0.1" || o.hostname === "localhost" || o.hostname === "[::1]") return true;
    if (/\.ts\.net$/i.test(o.hostname)) return true;
    return o.host === (request.headers.host || "");
  } catch { return false; }
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, port: opts.port, pid: process.pid, host: opts.host });
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
  jsonRes(res, 200, { available: true, url: info.url });
}

function pingHealth(baseUrl, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const target = new URL("/health", baseUrl);
      const req = http.request({
        method: "GET",
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        timeout: timeoutMs
      }, (res) => {
        res.resume();
        settle(res.statusCode === 200);
      });
      req.on("error", () => settle(false));
      req.on("timeout", () => { req.destroy(); settle(false); });
      req.end();
    } catch {
      settle(false);
    }
  });
}

function readVoiceInfo() {
  for (const file of VOICE_STATUS_FILES) {
    if (!existsSync(file)) continue;
    try {
      const info = JSON.parse(readFileSync(file, "utf8"));
      if (info?.url) return info;
    } catch {
      // try the next candidate
    }
  }
  return null;
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
    redemptionMs: num(process.env.VAD_REDEMPTION_MS, 550),
    minMs: num(process.env.ENDPOINT_MIN_MS, 350),
    maxMs: num(process.env.ENDPOINT_MAX_MS, 2600),
    bargeinProb: prob(process.env.BARGEIN_PROB, 0.55),
    bargeinConfirmMs: num0(process.env.BARGEIN_CONFIRM_MS, 350),
    // 0 disables the hands-free inactivity standby (session stays armed forever)
    idleTimeoutMs: num0(process.env.WAKE_IDLE_TIMEOUT_S, 90) * 1000
  });
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

// PROJECT_ROOT env (config_schema project_root) wins; otherwise whatever repo
// the server itself runs inside (the Fitting installs under the composition,
// which lives in the project checkout, so this resolves without config).
async function resolveProjectRoot() {
  const fromEnv = process.env.PROJECT_ROOT?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  try { return await runRead("git", ["rev-parse", "--show-toplevel"], process.cwd()); }
  catch { return null; }
}

// ── active-project ("workspace target") resolution ───────────────────────────
// The WORKSPACE panel must reflect the repo where DEV WORK is actually
// happening — the dev souls run under ~/dev, not this checkout — instead of the
// agent-garrison repo the HUD server itself lives in. Precedence:
//   1. a running dev session's cwd (auto-follow), EXCLUDING sessions whose repo
//      is this server's own repo (assistant/companion souls have no base_path so
//      their cwd is the composition dir = agent-garrison — following those would
//      re-point the panel at Jarvis itself, the exact thing we're fixing).
//   2. the last project we followed (persisted), so the panel doesn't blank the
//      moment a session ends.
//   3. PROJECT_ROOT env (the static config override), if set.
//   4. nothing — a calm empty state. We NEVER fall back to the server's own repo.
// Souls/skills/commands keep using resolveProjectRoot() (they ARE Jarvis's own
// config, correctly tied to the composition) — only the workspace follows this.
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

// last_summary_at may be a number (ms) or an ISO string; missing → 0.
function sessionRecency(s) {
  const v = s?.last_summary_at;
  if (typeof v === "number") return v;
  if (typeof v === "string") { const n = Date.parse(v); return Number.isNaN(n) ? 0 : n; }
  return 0;
}

async function computeWorkspaceRoot(opts) {
  const selfRoot = await resolveSelfRoot();
  const same = (a, b) => a && b && path.resolve(a) === path.resolve(b);
  // 1. auto-follow the most-recently-active running dev session
  try {
    const sess = await fetchJson(opts.gatewayUrl, "/sessions");
    const running = (Array.isArray(sess?.sessions) ? sess.sessions : [])
      .filter((s) => s && s.status === "running" && typeof s.cwd === "string" && s.cwd)
      .sort((a, b) => sessionRecency(b) - sessionRecency(a));
    for (const s of running) {
      if (!existsSync(s.cwd)) continue;
      let top;
      try { top = await runRead("git", ["rev-parse", "--show-toplevel"], s.cwd); }
      catch { continue; } // cwd isn't a git repo → not a workspace we can show
      if (!top || same(top, selfRoot)) continue; // skip Jarvis's own repo
      await persistWorkspace(top);
      return { root: top, source: "session" };
    }
  } catch { /* gateway unreachable → fall through to the persisted / env target */ }
  // 2. last followed project
  const last = readPersistedWorkspace();
  if (last && existsSync(last)) return { root: last, source: "last" };
  // 3. explicit static override
  const fromEnv = process.env.PROJECT_ROOT?.trim();
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

// Operative panel: runtime health + the agent surface (souls on disk, skills,
// commands) for the HUD's left flank. Souls/skills are FILES — the composition's
// souls/*.md and the repo's .claude/skills — so this only reads the disk; the
// live/standby distinction comes from the gateway's /sessions list client-side
// (a soul with a running session is live, the rest are standby).
const OPERATIVE_TTL_MS = 10_000;
let operativeCache = { at: 0, data: null };

function fetchJson(baseUrl, subpath, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const target = new URL(subpath, baseUrl);
      const req = http.request(
        { method: "GET", hostname: target.hostname, port: target.port, path: target.pathname, timeout: timeoutMs },
        (up) => {
          let raw = "";
          up.on("data", (c) => { raw += c; });
          up.on("end", () => { try { settle(JSON.parse(raw)); } catch { settle(null); } });
          up.on("error", () => settle(null));
        }
      );
      req.on("error", () => settle(null));
      req.on("timeout", () => { req.destroy(); settle(null); });
      req.end();
    } catch { settle(null); }
  });
}

async function handleOperative(res, opts) {
  const now = Date.now();
  if (operativeCache.data && now - operativeCache.at < OPERATIVE_TTL_MS) {
    jsonRes(res, 200, operativeCache.data);
    return;
  }
  const voiceInfo = readVoiceInfo();
  const [gateway, voice, root] = await Promise.all([
    fetchJson(opts.gatewayUrl, "/health"),
    voiceInfo?.url ? fetchJson(voiceInfo.url, "/health") : Promise.resolve(null),
    resolveProjectRoot()
  ]);
  // Souls live in the composition (compositions/<id>/souls/*.md); skills and
  // commands in the repo's / composition's .claude. All best-effort reads.
  const compositionId = process.env.GARRISON_COMPOSITION_ID?.trim() || "jarvis";
  const listNames = async (dir, stripExt) => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => (stripExt ? e.isFile() && e.name.endsWith(stripExt) : e.isDirectory()))
        .map((e) => (stripExt ? e.name.slice(0, -stripExt.length) : e.name))
        .filter((n) => !n.startsWith("."));
    } catch { return []; }
  };
  const compDir = root ? path.join(root, "compositions", compositionId) : null;
  const [souls, skills, commands] = await Promise.all([
    compDir ? listNames(path.join(compDir, "souls"), ".md") : Promise.resolve([]),
    root ? listNames(path.join(root, ".claude", "skills"), null) : Promise.resolve([]),
    compDir ? listNames(path.join(compDir, ".claude", "commands"), ".md") : Promise.resolve([])
  ]);
  const data = {
    gateway: gateway?.ok
      ? {
          ok: true, mode: gateway.mode ?? null, uptimeMs: gateway.uptime_ms ?? null,
          sessions: gateway.sessions_count ?? null, channels: gateway.channels_count ?? null
        }
      : { ok: false },
    voice: voice?.ok ? { ok: true, ready: Boolean(voice.enginesReady) } : { ok: false },
    souls, skills, commands
  };
  operativeCache = { at: now, data };
  jsonRes(res, 200, data);
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
function postJson(baseUrl, subpath, payload, res) {
  let target;
  try { target = new URL(subpath, baseUrl); } catch { jsonRes(res, 502, { error: "bad kanban target" }); return; }
  const upstream = http.request({
    method: "POST",
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    timeout: 5000
  }, (up) => {
    let raw = "";
    up.on("data", (c) => { raw += c; });
    up.on("end", () => {
      res.statusCode = up.statusCode || 502;
      res.setHeader("Content-Type", "application/json");
      res.end(raw || "{}");
      kanbanCache = { expires: 0, data: null };
    });
  });
  upstream.on("error", () => { try { jsonRes(res, 502, { error: "kanban unreachable" }); } catch {} });
  upstream.on("timeout", () => { try { upstream.destroy(); jsonRes(res, 504, { error: "kanban timeout" }); } catch {} });
  upstream.end(payload);
}

// Advance/start a card (voice "avança o card X"). Proxies kanban POST /cards/:id/start.
function handleKanbanStart(res, id) {
  const info = readFittingInfo(KANBAN_STATUS_FILE);
  if (!info?.url) { jsonRes(res, 503, { error: "kanban-loop fitting not available" }); return; }
  postJson(info.url, `/cards/${id}/start`, "{}", res);
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
  postJson(info.url, "/cards", payload, res);
}

// Thin GET proxy to the gateway for the Workspace panel's live lists
// (/sessions, /worktrees). Upstream errors — including the gateway's 502 when
// the dev-env worktrees proxy isn't stationed — degrade to the fallback body so
// the panel section simply omits itself instead of erroring.
function handleGatewayGet(req, res, opts, subpath, fallbackBody) {
  const target = new URL(subpath, opts.gatewayUrl);
  const upstream = http.request(
    {
      method: "GET",
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      headers: { Accept: "application/json" },
      timeout: 4000
    },
    (up) => {
      if ((up.statusCode || 500) >= 400) {
        up.resume();
        jsonRes(res, 200, fallbackBody);
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", up.headers["content-type"] || "application/json");
      up.pipe(res);
    }
  );
  upstream.on("timeout", () => { try { upstream.destroy(new Error("gateway timeout")); } catch {} });
  upstream.on("error", () => { try { jsonRes(res, 200, fallbackBody); } catch {} });
  upstream.end();
}

// Voice availability — mirrors handleMonitor. The web UI hides its mic / speaker
// controls when this reports unavailable.
async function handleVoiceInfo(res) {
  const info = readVoiceInfo();
  if (!info?.url) {
    jsonRes(res, 200, { available: false });
    return;
  }
  const ok = await pingHealth(info.url, 600);
  jsonRes(res, 200, ok ? { available: true, url: info.url } : { available: false });
}

// Binary proxy to the voice Fitting. Used for both /stt (audio in → JSON) and
// /tts (JSON in → audio out). pipeUpstreamSse/readJsonBody can't carry binary
// bodies, so this buffers the request and pipes the upstream response straight
// back, preserving the upstream Content-Type (audio/* or application/json).
// Same-origin so the browser needs no CORS, and the Deepgram key stays on the
// voice Fitting — the web UI never sees it.
async function handleVoiceProxy(req, res, subpath) {
  const info = readVoiceInfo();
  if (!info?.url) {
    jsonRes(res, 503, { error: "voice fitting not available" });
    return;
  }
  let body;
  try {
    body = await readRawBody(req);
  } catch (err) {
    jsonRes(res, 400, { error: `bad body: ${err.message}` });
    return;
  }
  const target = new URL(subpath, info.url);
  const upstream = http.request(
    {
      method: "POST",
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: {
        "Content-Type": req.headers["content-type"] || "application/octet-stream",
        "Content-Length": body.length
      },
      timeout: 30_000
    },
    (up) => {
      res.statusCode = up.statusCode || 502;
      if (up.headers["content-type"]) res.setHeader("Content-Type", up.headers["content-type"]);
      res.setHeader("Cache-Control", "no-store");
      up.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    if (res.headersSent) { try { res.destroy(err); } catch {} return; }
    try { jsonRes(res, 502, { error: `voice upstream: ${err.message}` }); } catch {}
  });
  upstream.on("timeout", () => { try { upstream.destroy(new Error("voice upstream timeout")); } catch {} });
  // If the client aborts (navigates away / cancels), tear down the upstream so a
  // slow voice request doesn't leak the socket (mirrors handleVoiceTtsGet).
  req.on("close", () => { try { upstream.destroy(); } catch {} });
  upstream.end(body);
}

// GET variant of /tts for progressive <audio src> playback. The voice Fitting
// streams a single growing WAV (header declares unknown length), so the browser
// can START PLAYING after the first synthesized sentence instead of waiting for
// the whole utterance. A POST+blob() in the UI would defeat that and add the
// full ~2s synth latency before any audio — this GET keeps the pipe open and
// lets the <audio> element consume it as it arrives.
async function handleVoiceTtsGet(req, res) {
  const info = readVoiceInfo();
  if (!info?.url) { jsonRes(res, 503, { error: "voice fitting not available" }); return; }
  const text = String(url.parse(req.url, true).query.text || "");
  if (!text.trim()) { jsonRes(res, 400, { error: "text is required" }); return; }
  const body = Buffer.from(JSON.stringify({ text, format: "wav" }), "utf8");
  const target = new URL("/tts", info.url);
  const upstream = http.request(
    {
      method: "POST",
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { "Content-Type": "application/json", "Content-Length": body.length }
    },
    (up) => {
      res.statusCode = up.statusCode || 502;
      if (up.headers["content-type"]) res.setHeader("Content-Type", up.headers["content-type"]);
      res.setHeader("Cache-Control", "no-store");
      up.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    try { jsonRes(res, 502, { error: `voice upstream: ${err.message}` }); } catch {}
  });
  req.on("close", () => { try { upstream.destroy(); } catch {} });
  upstream.end(body);
}

// Pure passthrough relay: browser WS ⇄ voice Fitting WS (`/stream` for live
// PCM STT, `/events` for wake-word + hello events). Binary and text frames are
// forwarded verbatim in both directions; frames sent before the upstream opens
// are buffered briefly.
function relayVoiceStream(client, voiceHttpUrl, search, upstreamPath = "/stream") {
  const upstreamUrl = voiceHttpUrl.replace(/^http/, "ws").replace(/\/+$/, "") + upstreamPath + (search || "");
  const upstream = new WebSocket(upstreamUrl);
  const pending = [];
  // Cap the pre-open buffer: the client streams ~50 mic frames/s, so if the
  // upstream is slow to connect (or never does) this would grow without bound.
  // ~256 frames ≈ a few seconds; past that, drop the oldest.
  const MAX_PENDING = 256;

  upstream.on("open", () => {
    for (const { data, isBinary } of pending) upstream.send(data, { binary: isBinary });
    pending.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", () => { pending.length = 0; try { client.close(); } catch {} });
  upstream.on("error", () => { pending.length = 0; try { client.close(); } catch {} });

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else { pending.push({ data, isBinary }); if (pending.length > MAX_PENDING) pending.shift(); }
  });
  client.on("close", () => { try { upstream.close(); } catch {} });
  client.on("error", () => { try { upstream.close(); } catch {} });
}

function readRawBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function pipeUpstreamSse(req, res, upstreamOpts, upstreamBody) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const upstream = http.request(upstreamOpts, (up) => {
    if (up.statusCode && up.statusCode >= 400) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: `upstream ${up.statusCode}` })}\n\n`);
      up.resume();
      res.end();
      return;
    }
    up.on("data", (chunk) => {
      try { res.write(chunk); } catch {}
    });
    up.on("end", () => {
      try { res.end(); } catch {}
    });
    up.on("error", (err) => {
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`); } catch {}
      try { res.end(); } catch {}
    });
  });
  upstream.on("error", (err) => {
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    } catch {}
  });
  req.on("close", () => {
    try { upstream.destroy(); } catch {}
  });
  if (upstreamBody !== undefined) {
    upstream.write(upstreamBody);
  }
  upstream.end();
}

function handleStream(req, res, opts) {
  // live=1: the voice UI speaks each Soul reply as it lands, so it must NOT get
  // the ring-buffer replay (no re-speaking old replies on connect/reconnect).
  const target = new URL(`/channels/${CHANNEL_ID}/stream?live=1`, opts.gatewayUrl);
  pipeUpstreamSse(req, res, {
    method: "GET",
    hostname: target.hostname,
    port: target.port,
    path: target.pathname + target.search, // keep ?live=1
    headers: { Accept: "text/event-stream" }
  });
}

// Rich chat surface: proxy /api/claude/* to the gateway's /claude/*. The SSE
// stream uses pipeUpstreamSse; the JSON actions buffer + forward.
function handleClaudeStream(req, res, opts) {
  const target = new URL("/claude/stream", opts.gatewayUrl);
  pipeUpstreamSse(req, res, {
    method: "GET",
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    headers: { Accept: "text/event-stream" }
  });
}

async function handleClaudeProxy(req, res, opts, subpath, method) {
  let payload;
  if (method === "POST") {
    try {
      payload = JSON.stringify(await readJsonBody(req));
    } catch (err) {
      return jsonRes(res, 400, { error: `invalid json: ${err.message}` });
    }
  }
  const target = new URL(`/claude/${subpath}`, opts.gatewayUrl);
  const headers = { Accept: "application/json" };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  const upstream = http.request(
    { method, hostname: target.hostname, port: target.port, path: target.pathname + (target.search || ""), headers, timeout: 15_000 },
    (up) => {
      res.statusCode = up.statusCode || 502;
      res.setHeader("Content-Type", up.headers["content-type"] || "application/json");
      up.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    if (res.headersSent) { try { res.destroy(err); } catch {} return; }
    try { jsonRes(res, 502, { error: `gateway: ${err.message}` }); } catch {}
  });
  upstream.on("timeout", () => { try { upstream.destroy(new Error("gateway timeout")); } catch {} });
  req.on("close", () => { try { upstream.destroy(); } catch {} });
  if (payload !== undefined) upstream.write(payload);
  upstream.end();
}

async function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
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
  pipeUpstreamSse(req, res, {
    method: "POST",
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
  let target;
  try { target = new URL(subpath, baseUrl); } catch { jsonRes(res, 502, { error: "bad dev-env target" }); return; }
  const headers = { Accept: "application/json" };
  let body;
  if (payload !== undefined) {
    body = Buffer.from(JSON.stringify(payload));
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = body.length;
  }
  const upstream = http.request(
    { method, hostname: target.hostname, port: target.port, path: target.pathname + (target.search || ""), headers, timeout: timeoutMs },
    (up) => {
      let raw = "";
      up.on("data", (c) => { raw += c; });
      up.on("end", () => {
        res.statusCode = up.statusCode || 502;
        res.setHeader("Content-Type", up.headers["content-type"] || "application/json");
        res.end(raw || "{}");
      });
    }
  );
  upstream.on("error", (err) => { try { jsonRes(res, 502, { error: `dev-env: ${err.message}` }); } catch {} });
  upstream.on("timeout", () => { try { upstream.destroy(); jsonRes(res, 504, { error: "dev-env timeout" }); } catch {} });
  if (body !== undefined) upstream.write(body);
  upstream.end();
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
  proxyJson(res, base, "/sessions", "POST", payload, 20000);
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
  proxyJson(res, base, `/sessions/${encodeURIComponent(sessionId)}/instruct`, "POST", payload, 10000);
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
  pipeUpstreamSse(req, res, {
    method: "GET",
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
  proxyJson(res, base, `/sessions/${encodeURIComponent(sessionId)}/claude/interrupt`, "POST", {}, 5000);
}

function serveStatic(req, res, distDir) {
  let pathname = url.parse(req.url).pathname || "/";
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(distDir, pathname.replace(/^\/+/, ""));
  // Confine to distDir with a separator boundary — a bare startsWith(distDir)
  // would also admit a sibling `dist-secrets/…` directory.
  if (filePath !== distDir && !filePath.startsWith(distDir + path.sep)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  if (!existsSync(filePath)) {
    const indexFallback = path.join(distDir, "index.html");
    if (existsSync(indexFallback)) {
      const data = readFileSync(indexFallback);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Cache-Control", "no-cache");
      res.end(data);
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("web-channel: dist/ not built yet — run `node ui/build.mjs` in the Fitting directory.");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const ctMap = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".map": "application/json",
    // Silero VAD runtime: the WASM binary must be application/wasm for
    // WebAssembly streaming compilation; the .onnx model is an opaque blob.
    ".wasm": "application/wasm",
    ".onnx": "application/octet-stream"
  };
  res.statusCode = 200;
  res.setHeader("Content-Type", ctMap[ext] ?? "application/octet-stream");
  // HTML/JS/CSS keep a static filename but change on every rebuild, so force
  // revalidation — otherwise the browser serves a stale HUD from disk cache and
  // updates stay invisible (there's no content hash / ETag to bust it). The big
  // immutable VAD assets (.wasm/.onnx) stay long-cacheable.
  if (ext === ".html" || ext === ".js" || ext === ".mjs" || ext === ".css") {
    res.setHeader("Cache-Control", "no-cache");
  } else if (ext === ".wasm" || ext === ".onnx") {
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  }
  createReadStream(filePath).pipe(res);
}

async function findFreePort(startPort, host) {
  const net = await import("node:net");
  for (let port = startPort; port < startPort + 50; port++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, host);
    });
    if (free) return port;
  }
  return null;
}

async function writeStatusFile(opts) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({
    fittingId: "jarvis-os",
    port: opts.port,
    url: `${opts.scheme ?? "http"}://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString()
  }, null, 2));
}

async function clearStatusFile() {
  try { await unlink(STATUS_FILE); } catch {}
}

export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  const distDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "dist");

  const free = await findFreePort(opts.port, opts.host);
  if (free === null) {
    console.error(`[jarvis-os] no free port found starting from ${opts.port}`);
    process.exit(1);
  }
  // Optional TLS so mobile browsers get a secure context (getUserMedia / mic
  // capture is blocked on plain http over a LAN IP). When tls_cert/tls_key are
  // configured and readable, serve https; otherwise plain http (localhost is a
  // secure context, so desktop dev and Playwright are unaffected).
  let tls = null;
  if (opts.tlsCert && opts.tlsKey && existsSync(opts.tlsCert) && existsSync(opts.tlsKey)) {
    try {
      tls = { cert: readFileSync(opts.tlsCert), key: readFileSync(opts.tlsKey) };
    } catch (err) {
      console.error(`[jarvis-os] failed to read TLS cert/key, falling back to http: ${err.message}`);
      tls = null;
    }
  }
  const liveOpts = { ...opts, port: free, scheme: tls ? "https" : "http" };

  const requestHandler = async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";
      if (pathname === "/health" || pathname === "/api/health") return handleHealth(req, res, liveOpts);
      if (pathname === "/api/monitor" && method === "GET") return handleMonitor(req, res);
      if (pathname === "/api/voice" && method === "GET") return handleVoiceInfo(res);
      if (pathname === "/api/endpointing" && method === "GET") return handleEndpointing(res);
      if (pathname === "/api/project" && method === "GET") return handleProject(res, liveOpts);
      if (pathname === "/api/diff" && method === "GET") return handleDiff(res, liveOpts);
      if (pathname === "/api/kanban" && method === "GET") return handleKanban(res);
      if (pathname === "/api/kanban/cards" && method === "POST") return handleKanbanCreate(req, res);
      const kbStart = pathname.match(/^\/api\/kanban\/cards\/([0-9A-HJKMNP-TV-Z]{26})\/start$/i);
      if (kbStart && method === "POST") return handleKanbanStart(res, kbStart[1]);
      if (pathname === "/api/operative" && method === "GET") return handleOperative(res, liveOpts);
      if (pathname === "/api/sessions" && method === "GET") return handleGatewayGet(req, res, liveOpts, "/sessions", { sessions: [] });
      // Real multi-session engine (dev-env) — the HUD's session switcher.
      if (pathname === "/api/dev-sessions" && method === "GET") return handleDevSessions(req, res, liveOpts);
      if (pathname === "/api/dev-sessions" && method === "POST") return handleDevCreate(req, res, liveOpts);
      {
        const m = pathname.match(/^\/api\/dev-sessions\/([^/]+)\/instruct$/);
        if (m && method === "POST") return handleDevInstruct(req, res, liveOpts, decodeURIComponent(m[1]));
      }
      {
        const m = pathname.match(/^\/api\/dev-sessions\/([^/]+)\/stream$/);
        if (m && method === "GET") return handleDevStream(req, res, liveOpts, decodeURIComponent(m[1]));
      }
      {
        const m = pathname.match(/^\/api\/dev-sessions\/([^/]+)\/interrupt$/);
        if (m && method === "POST") return handleDevInterrupt(req, res, liveOpts, decodeURIComponent(m[1]));
      }
      if (pathname === "/api/worktrees" && method === "GET") {
        // Scope the worktrees list to the active project so it actually
        // populates (the gateway needs a ?project= repo path; without it the
        // dev-env proxy 400s and we degrade to the empty fallback).
        const wsRoot = (await resolveWorkspaceRoot(liveOpts)).root;
        const sub = wsRoot ? `/worktrees?project=${encodeURIComponent(wsRoot)}` : "/worktrees";
        return handleGatewayGet(req, res, liveOpts, sub, { worktrees: [] });
      }
      if (pathname === "/api/voice/stt" && method === "POST") return handleVoiceProxy(req, res, "/stt");
      if (pathname === "/api/voice/tts" && method === "POST") return handleVoiceProxy(req, res, "/tts");
      if (pathname === "/api/voice/tts" && method === "GET") return handleVoiceTtsGet(req, res);
      if (pathname === "/api/stream" && method === "GET") return handleStream(req, res, liveOpts);
      if (pathname === "/api/chat" && method === "POST") return handleChat(req, res, liveOpts);
      if (pathname === "/api/claude/stream" && method === "GET") return handleClaudeStream(req, res, liveOpts);
      if (pathname === "/api/claude/status" && method === "GET") return handleClaudeProxy(req, res, liveOpts, "status", "GET");
      if (pathname === "/api/claude/commands" && method === "GET") return handleClaudeProxy(req, res, liveOpts, "commands", "GET");
      if (pathname === "/api/claude/message" && method === "POST") return handleClaudeProxy(req, res, liveOpts, "message", "POST");
      if (pathname === "/api/claude/keys" && method === "POST") return handleClaudeProxy(req, res, liveOpts, "keys", "POST");
      if (pathname === "/api/claude/mode" && method === "POST") return handleClaudeProxy(req, res, liveOpts, "mode", "POST");
      if (pathname === "/api/claude/interrupt" && method === "POST") return handleClaudeProxy(req, res, liveOpts, "interrupt", "POST");
      if (pathname.startsWith("/api/")) {
        jsonRes(res, 404, { error: "not found", path: pathname });
        return;
      }
      return serveStatic(req, res, distDir);
    } catch (err) {
      console.error("[jarvis-os] handler error:", err);
      jsonRes(res, 500, { error: err.message });
    }
  };

  const server = tls
    ? https.createServer(tls, requestHandler)
    : http.createServer(requestHandler);

  // Streaming voice: pure passthrough WS relay browser ⇄ voice Fitting /stream.
  // No parsing — all Deepgram logic stays in the voice Fitting; the key never
  // reaches the browser. The page connects to /api/voice/stream (wss when this
  // server is TLS), and we forward the query (sample_rate) verbatim.
  const wss = new WebSocketServer({ noServer: true });
  const WS_PATHS = { "/api/voice/stream": "/stream", "/api/voice/events": "/events" };
  server.on("upgrade", (request, socket, head) => {
    // WebSocket is NOT covered by the same-origin policy, so a malicious page in
    // the user's browser could open this voice relay (cross-site WS hijacking).
    // Reject a browser Origin that isn't same-host / loopback / tailnet. Native
    // clients send no Origin and pass.
    if (!wsOriginAllowed(request)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const parsed = url.parse(request.url || "/", true);
    const upstreamPath = WS_PATHS[parsed.pathname || ""];
    if (!upstreamPath) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const info = readVoiceInfo();
    if (!info?.url) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => relayVoiceStream(client, info.url, parsed.search || "", upstreamPath));
  });

  server.listen(liveOpts.port, liveOpts.host, async () => {
    await writeStatusFile(liveOpts);
    console.log(`[jarvis-os] listening on ${liveOpts.scheme}://${liveOpts.host}:${liveOpts.port} (gateway=${liveOpts.gatewayUrl})`);
  });

  const shutdown = async (signal) => {
    console.log(`[jarvis-os] shutdown (${signal})`);
    await clearStatusFile();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { server, options: liveOpts };
}

const isDirect = (() => {
  if (!import.meta.url) return false;
  try {
    return path.resolve(url.fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "");
  } catch {
    return false;
  }
})();

if (isDirect) {
  startServer().catch((err) => {
    console.error("[jarvis-os] failed to start:", err);
    process.exit(1);
  });
}
