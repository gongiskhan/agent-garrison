#!/usr/bin/env node
// dev-env backend — the consolidated Dev Env Fitting (port 7086). One server
// folds the three retired dev-work Fittings into a single surface:
//   - PTY terminals (ptys.mjs, from terminal-armory-default)
//   - session state + Claude Code hook receiver (state.mjs, from
//     session-view-sequoias) — every Claude Code session becomes a tab
//   - git worktree CRUD (worktrees.mjs, from worktree-management-sequoias)
// Scaffolding (routing, WS upgrade, status file, static serving) follows the
// terminal donor.

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { WebSocketServer } from "ws";
import {
  allocateTerminalRole,
  ensurePty,
  getPty,
  isTmuxMode,
  killPty,
  killSessionPtys,
  listParked,
  listPtys,
  listSessionTerminals,
  mirrorHandle,
  ptyIdFor,
  ptySummary,
  rehydratePtys,
  resizePty,
  setDefaultShell,
  setTmuxMode,
  shutdownPtys
} from "./ptys.mjs";
import {
  listGarrisonSessions,
  sessionIdRoleFromName,
  tmuxAvailable,
  tmuxCapturePane,
  tmuxSessionName
} from "./tmux.mjs";
import { DEFAULT_EXCLUDES, getExcludes, isExcluded, loadExcludes, saveExcludes } from "./excludes.mjs";
import {
  openRichStream,
  richStatus,
  keySequence,
  cycleMode,
  enumerateCommandsCached
} from "@garrison/claude-pty";
import {
  aggregateSessions,
  applyHookEvent,
  cleanupState,
  getDirty,
  hasLiveClaudeProcess,
  isBroadRoot,
  liveRegistryRows,
  migrateOpenSet,
  openSessionByClaudeId,
  readStateFile,
  runWorkingIdleFallback,
  setDirtyCheckTtl,
  setSessionOpen
} from "./state.mjs";
import { listHistory } from "./claude-sessions.mjs";
import {
  createProjectSession,
  createWorktree,
  deleteSession,
  expandHome,
  findSessionById,
  isWorktreePath,
  listProjects,
  listWorktreesEnriched,
  readDevRoot,
  removeSessionRecord,
  setPaneClosed,
  writeDevRoot
} from "./worktrees.mjs";

const FITTING_ID = "dev-env";
const DEFAULT_PORT = 7086;

const HOME = os.homedir();
const STATUS_ROOT = path.join(HOME, ".garrison", "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, `${FITTING_ID}.json`);
const BROWSER_STATUS_FILE = path.join(STATUS_ROOT, "browser-default.json");
const VOICE_STATUS_FILE = path.join(STATUS_ROOT, "deepgram-voice.json");

const EXTERNAL_STATUSES = new Set(["working", "waiting", "starting"]);

function parseArgs(argv) {
  const out = {
    port: Number(process.env.DEV_ENV_PORT || DEFAULT_PORT),
    host: process.env.DEV_ENV_HOST || "127.0.0.1",
    defaultShell: process.env.DEV_ENV_SHELL || process.env.SHELL || "/bin/zsh",
    dirtyTtlMs: Number(process.env.DEV_ENV_DIRTY_TTL_MS || 10_000),
    // PTY backing: auto (tmux if installed, else direct), on (require tmux),
    // off (direct node-pty). tmux keeps shells/claude alive across restarts.
    useTmux: String(process.env.DEV_ENV_USE_TMUX || "auto").toLowerCase()
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--shell") out.defaultShell = argv[++i];
    else if (a === "--use-tmux") out.useTmux = String(argv[++i] || "auto").toLowerCase();
  }
  return out;
}

// Resolve the requested PTY backing into a concrete on/off decision. `on`
// hard-fails when tmux is missing (the operator explicitly asked for
// persistence); `auto` silently falls back to direct spawning.
function resolveTmuxMode(useTmux) {
  if (useTmux === "off") return false;
  if (useTmux === "on") {
    if (!tmuxAvailable()) {
      console.error("[dev-env] use_tmux=on but tmux is not installed — refusing to start without it");
      process.exit(1);
    }
    return true;
  }
  return tmuxAvailable(); // auto
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// CSRF guard for mutating routes. This server spawns `claude` in arbitrary
// directories, so a drive-by web page must not be able to POST to it. Browsers attach an
// Origin header to cross-site requests; our own UI is same-origin (Origin
// host === Host), and server-to-server consumers (gateway passthrough, curl)
// send no Origin at all. Anything else is rejected.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser caller (gateway passthrough, curl)
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false; // includes "Origin: null" (sandboxed/opaque origins)
  }
}

// True when a claude pane's visible lines show a turn IN FLIGHT. Two on-screen
// forms count:
//   1. the classic interrupt hint "(esc to interrupt)" shown during tool use /
//      streaming; and
//   2. the extended-thinking spinner "✻ Inferring… (21m 7s · ↓ 72.5k tokens)",
//      which under high reasoning effort runs for MINUTES with no interrupt
//      hint — only a live elapsed timer + token counter. Hooks fire nothing
//      through this phase, which is exactly when the tab spinner used to drop.
// The completion line "✻ Baked for 3s" carries neither a token counter nor a
// parenthetical, so it is excluded; the `for Ns` done suffix is excluded too.
const SPINNER_DONE_LINE = /\bfor \d+(?:\.\d+)?s\s*$/i;
function paneLinesBusy(lines) {
  for (const l of lines) {
    if (/\(esc to interrupt\)/i.test(l)) return true;
    if (/\btokens?\b/i.test(l) && /\b\d+\s*s\b/.test(l) && !SPINNER_DONE_LINE.test(l)) return true;
  }
  return false;
}

// Session ids that own a live claude tmux session (role === "claude"). One
// `tmux list-sessions` exec; used to bound pane captures to real claude panes.
function garrisonClaudeSessionIds() {
  const ids = new Set();
  for (const name of listGarrisonSessions()) {
    const parsed = sessionIdRoleFromName(name);
    if (parsed && parsed.role === "claude") ids.add(parsed.sessionId);
  }
  return ids;
}

// "Is this session's claude processing a turn right now" — ground truth,
// independent of hook delivery AND of whether our attach-client record is in
// sync. In tmux mode the live pane content (capture-pane) is authoritative even
// when the in-memory PTY record drifted to none/exited; in legacy mode we read
// the headless mirror. Memoised ~1s so a burst of /sessions polls (one per open
// browser tab) doesn't multiply tmux execs.
const busyCache = new Map(); // sessionId -> { value, at }
const BUSY_CACHE_MS = 1000;
function claudeBusy(sessionId) {
  const cached = busyCache.get(sessionId);
  if (cached && Date.now() - cached.at < BUSY_CACHE_MS) return cached.value;
  let value = false;
  if (isTmuxMode()) {
    const lines = tmuxCapturePane(tmuxSessionName(ptyIdFor(sessionId, "claude")));
    value = Array.isArray(lines) && paneLinesBusy(lines);
  } else {
    const rec = getPty(ptyIdFor(sessionId, "claude"));
    if (rec && rec.state === "running") {
      const handle = mirrorHandle(rec);
      if (handle) { try { value = richStatus(handle).busy === true; } catch { value = false; } }
    }
  }
  busyCache.set(sessionId, { value, at: Date.now() });
  return value;
}

// Session ids whose claude turn is in flight right now — fed to the
// working→idle fallback so it never demotes a session that is plainly working.
function liveBusySessionIds() {
  const ids = new Set();
  const candidates = isTmuxMode()
    ? garrisonClaudeSessionIds()
    : new Set(listPtys().filter((r) => r.role === "claude" && r.state === "running").map((r) => r.sessionId));
  for (const sessionId of candidates) {
    if (claudeBusy(sessionId)) ids.add(sessionId);
  }
  return ids;
}

// DevEnvSession assembly: one row per aggregate session, decorated with PTY
// summaries, git-dirty, and the external flag. Also the orphan sweep — PTYs
// (and parked claude envelopes) whose session row vanished (deleted cwd,
// cleared record) are killed + forgotten here.
function assembleSessions() {
  const rows = aggregateSessions();
  // Real claude panes worth a live busy read this pass (one list-sessions
  // exec). Bounds capture-pane to actual claude sessions instead of every row.
  const tmuxClaudeIds = isTmuxMode() ? garrisonClaudeSessionIds() : null;
  const out = [];
  for (const row of rows) {
    if (!row.id) continue; // legacy rows without an id cannot be addressed
    const claudePty = ptySummary(row.id, "claude");
    // Every shell terminal for the session (0..N). The single auto-spawned
    // shell was retired — terminals are created on demand and tiled by the UI.
    const terminals = listSessionTerminals(row.id);
    const external = claudePty.state !== "running" && EXTERNAL_STATUSES.has(row.lastStatus);
    // Promote to "working" off the live screen whenever claude is actually
    // processing a turn — including the long thinking phase that fires no hooks,
    // so the hook-driven 60s fallback would otherwise drop the tab spinner mid
    // run. Only PROMOTE here; demotion stays with the Stop hook + the (now
    // busy-guarded) fallback, which avoids flicker at turn start. Bounded to
    // panes that exist: external/no-claude rows keep their hook status.
    const hasClaudePane = tmuxClaudeIds ? tmuxClaudeIds.has(row.id) : claudePty.state === "running";
    let lastStatus = row.lastStatus;
    const busy = hasClaudePane ? claudeBusy(row.id) : false;
    claudePty.busy = busy;
    if (busy) lastStatus = "working";
    out.push({
      id: row.id,
      branch: row.branch,
      worktreePath: row.worktreePath,
      projectName: row.projectName,
      projectPath: row.projectPath,
      lastStatus,
      lastStatusAt: row.lastStatusAt,
      claudeSessionId: row.claudeSessionId,
      title: row.title,
      source: row.source,
      dirty: getDirty(row.worktreePath),
      isWorktree: isWorktreePath(row.worktreePath),
      external,
      excluded: isExcluded(row.worktreePath),
      isBroadRoot: isBroadRoot(row.worktreePath),
      liveProcess: hasLiveClaudeProcess(row.worktreePath, row.claudeSessionId),
      openedInDevEnv: row.openedInDevEnv === true,
      claudeClosed: Boolean(row.panesClosed?.claude),
      claudePty,
      terminals
    });
  }
  // Orphan sweep. A PTY (and, under tmux, its crash-persistent session) is an
  // orphan only when its session record is GONE from the ledger entirely — not
  // when the aggregate merely HID it (a missing / temporarily-unmounted cwd),
  // and not when state.json was transiently unreadable. Both of those would
  // empty/shrink `rows` without the session being truly deleted, and killing on
  // that signal silently stops live Claude sessions. So reap against the RAW
  // id set, and never when it's empty (empty ⇒ untrustworthy ⇒ reap nothing;
  // a genuine no-sessions state also has no PTYs to reap). Real deletions go
  // through deleteSession / close / cleanup, which forget their PTYs directly.
  const rawIds = rawSessionIds();
  if (rawIds.size > 0) {
    for (const rec of listPtys()) {
      if (!rawIds.has(rec.sessionId)) killPty(rec.id, { forget: true });
    }
    for (const parkedId of listParked()) {
      const m = parkedId.match(/^(.+)-(claude|shell(?:-\d+)?)$/);
      if (m && !rawIds.has(m[1])) killPty(parkedId, { forget: true });
    }
  }
  return out;
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, {
    ok: true,
    fittingId: FITTING_ID,
    port: opts.port,
    pid: process.pid,
    host: opts.host,
    tmux: isTmuxMode(),
    ptys: listPtys().length
  });
}

function getTailscaleIp() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      // Tailscale uses 100.64.0.0/10 (CGNAT range).
      const m = iface.address.match(/^100\.(\d+)\./);
      if (!m) continue;
      const n = Number(m[1]);
      if (n >= 64 && n <= 127) return iface.address;
    }
  }
  return null;
}

function handleTailscaleIp(req, res) {
  const ip = getTailscaleIp();
  if (!ip) return jsonRes(res, 404, { error: "no tailscale interface found" });
  jsonRes(res, 200, { ip });
}

async function handleBrowserTarget(_req, res) {
  try {
    const raw = await readFile(BROWSER_STATUS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.url !== "string") {
      return jsonRes(res, 404, { error: "browser status file invalid" });
    }
    jsonRes(res, 200, {
      url: parsed.url,
      port: parsed.port ?? null,
      pid: parsed.pid ?? null,
      cdpWsEndpoint: parsed.cdpWsEndpoint ?? null
    });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return jsonRes(res, 404, { error: "browser fitting not running" });
    }
    jsonRes(res, 500, { error: err.message });
  }
}

async function handleAppPort(req, res, queryParams) {
  const cwd = expandHome(queryParams.cwd || "");
  if (!cwd) return jsonRes(res, 400, { error: "cwd required" });
  try {
    const raw = await readFile(path.join(cwd, "app.port"), "utf8");
    const port = Number(raw.trim());
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return jsonRes(res, 404, { error: "invalid app.port file" });
    }
    jsonRes(res, 200, { port });
  } catch (err) {
    if (err && err.code === "ENOENT") return jsonRes(res, 404, { error: "app.port not found" });
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function handleListSessions(req, res) {
  try {
    jsonRes(res, 200, { sessions: assembleSessions() });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// GET /sessions/agents — every live `claude` on the machine (Claude Code's own
// registry), tagged whether it is already open as a tab here. The Agents panel
// groups these by project; clicking one opens/jumps to its tab.
function handleListAgents(req, res) {
  try {
    const ledger = assembleSessions();
    const openSids = new Set(ledger.filter((s) => s.openedInDevEnv && s.claudeSessionId).map((s) => s.claudeSessionId));
    const sidToTab = new Map(ledger.filter((s) => s.claudeSessionId).map((s) => [s.claudeSessionId, s.id]));
    const agents = liveRegistryRows().map((r) => ({
      sessionId: r.sessionId,
      cwd: r.cwd,
      pid: r.pid,
      status: r.status,
      // Matched by sessionId only — the strong, exact key. No loose cwd match
      // (which would mis-tag a different session living in the same directory).
      isOpen: openSids.has(r.sessionId),
      tabId: sidToTab.get(r.sessionId) ?? null
    }));
    jsonRes(res, 200, { agents });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// GET /sessions/history?days=N — past sessions from Claude Code's transcript
// store, titled, excluding any currently live (Agents) or open (tabs) so the
// three lists never duplicate.
function handleListHistory(req, res, query) {
  try {
    const days = Number(query.days);
    const hist = listHistory({ windowDays: Number.isFinite(days) && days > 0 ? days : 30 });
    const liveSids = new Set(liveRegistryRows().map((r) => r.sessionId));
    const openSids = new Set(
      assembleSessions()
        .filter((s) => s.openedInDevEnv && s.claudeSessionId)
        .map((s) => s.claudeSessionId)
    );
    const history = hist.filter((h) => !liveSids.has(h.sessionId) && !openSids.has(h.sessionId));
    jsonRes(res, 200, { history });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// POST /sessions/open — open a session as a tab from the Agents/History panel.
// Body: { sessionId: <claudeSessionId>, cwd, title?, branch? }. Upserts a ledger
// record carrying the claudeSessionId and pins it (openedInDevEnv) — but does
// NOT spawn. The Claude PTY is resumed lazily on first focus (POST
// /sessions/:id/ptys threads the record's claudeSessionId as the resumeId).
const SAFE_CLAUDE_SESSION_ID = /^[0-9a-fA-F-]{8,64}$/;
async function handleOpenSession(req, res) {
  const body = (await readBody(req)) || {};
  const claudeSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const cwd = typeof body.cwd === "string" ? expandHome(body.cwd) : null;
  // A valid Claude session id is REQUIRED: it is the resume key, the UNIQUE
  // ledger key (two sessions in one cwd must not collapse to one tab), and it is
  // spliced into the resume shell command — so it must match the UUID charset.
  if (!SAFE_CLAUDE_SESSION_ID.test(claudeSessionId)) {
    return jsonRes(res, 400, { error: "sessionId must be a valid Claude session id" });
  }
  if (!cwd) return jsonRes(res, 400, { error: "cwd required" });
  try {
    const session = await openSessionByClaudeId({
      claudeSessionId,
      cwd,
      title: typeof body.title === "string" ? body.title : null,
      branch: typeof body.branch === "string" ? body.branch : null
    });
    const assembled = assembleSessions().find((s) => s.id === session.id) ?? null;
    jsonRes(res, 200, { id: session.id, session: assembled });
  } catch (err) {
    jsonRes(res, err.status ?? 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// POST /sessions/:id/ptys — ensure/restart a SPECIFIC pty (claude, or an
// existing shell terminal by its role e.g. "shell-2"). Adding a brand-new
// terminal goes through POST /sessions/:id/terminals instead.
const TERMINAL_ROLE_RE = /^shell(?:-\d+)?$/;
async function handleEnsurePty(req, res, sessionId) {
  const body = (await readBody(req)) || {};
  const role =
    body.role === "claude" ? "claude" : (typeof body.role === "string" && TERMINAL_ROLE_RE.test(body.role) ? body.role : null);
  if (!role) return jsonRes(res, 400, { error: 'role must be "claude" or a shell terminal role' });
  const found = findSessionById(sessionId);
  if (!found) return jsonRes(res, 404, { error: `session id not found: ${sessionId}` });
  try {
    ensurePty({
      session: { id: sessionId, worktreePath: found.worktreePath },
      role,
      resume: body.resume === true,
      resumeId: role === "claude" ? found.claudeSessionId || null : null
    });
    // Starting the claude pane clears its closed marker for every connected
    // client. Shell terminals carry no closed marker (they are explicit now).
    if (role === "claude") await setPaneClosed(sessionId, role, false);
    jsonRes(res, 200, { ok: true, pty: ptySummary(sessionId, role) });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// POST /sessions/:id/terminals — open a NEW shell terminal for the session.
// Allocates the next free role and spawns it; the UI's next /sessions poll
// picks it up and tiles it into the deck.
async function handleCreateTerminal(req, res, sessionId) {
  const found = findSessionById(sessionId);
  if (!found) return jsonRes(res, 404, { error: `session id not found: ${sessionId}` });
  try {
    const role = allocateTerminalRole(sessionId);
    ensurePty({ session: { id: sessionId, worktreePath: found.worktreePath }, role });
    jsonRes(res, 201, { ok: true, role, pty: ptySummary(sessionId, role) });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// Send an instruction into the running Claude PTY. The two-phase write
// (text, pause, "\r") is deliberate: single-chunk text+"\r" can be swallowed
// as a multiline paste by the Ink TUI, and the pause lets /run's slash-menu
// resolve before Enter. Default pause is 600ms — 300ms was observed to lose
// the Enter against a live claude TUI.
async function handleInstruct(req, res, sessionId) {
  const body = (await readBody(req)) || {};
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) return jsonRes(res, 400, { error: "text required" });
  const rec = getPty(ptyIdFor(sessionId, "claude"));
  if (!rec || rec.state !== "running" || rec.claudeAlive === false) {
    return jsonRes(res, 409, { error: "no running Claude PTY for this session" });
  }
  try {
    rec.pty.write(text);
    const delayMs = Number.isFinite(body.delayMs) ? Math.max(0, Math.min(5000, body.delayMs)) : 600;
    await sleep(delayMs);
    rec.pty.write("\r");
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleDeleteSession(req, res, sessionId) {
  try {
    const removed = await deleteSession(sessionId);
    killSessionPtys(sessionId, { forget: true });
    jsonRes(res, 200, { ok: true, id: sessionId, removed });
  } catch (err) {
    jsonRes(res, err.status ?? 500, { error: err.message });
  }
}

// POST /sessions — "Start session": record + both PTYs for an arbitrary
// project directory. Reuses an existing record for the same cwd; claude
// resumes (--continue) when the reused record already saw a claude session,
// or when the caller asks explicitly (`continue: true`, the "Continue session"
// dialog) — `claude --continue` then resumes the most recent conversation in
// that directory regardless of whether we already had a record for it.
// EXCEPT when the reused record looks external (claude running elsewhere,
// hooks busy): silently double-attaching a second `claude --continue` is
// exactly what the UI's Take-over overlay exists to warn about, so only the
// shell spawns and the overlay handles the rest.
async function handleCreateSession(req, res) {
  const body = (await readBody(req)) || {};
  try {
    const { session, existed } = await createProjectSession({ path: body.path, title: body.title });
    const stub = { id: session.id, worktreePath: session.worktreePath };
    const externalNow =
      existed &&
      ptySummary(session.id, "claude").state !== "running" &&
      EXTERNAL_STATUSES.has(session.lastStatus);
    if (!externalNow) {
      const wantContinue = body.continue === true || body.resume === true;
      ensurePty({
        session: stub,
        role: "claude",
        resume: wantContinue || (existed && Boolean(session.claudeSessionId)),
        resumeId: session.claudeSessionId || null
      });
    }
    // No default shell terminal — the deck starts empty; the user opens
    // terminals on demand via the + button.
    await setPaneClosed(session.id, "claude", false);
    // Starting/opening a session in dev-env pins it as a tab (survives reboot).
    await setSessionOpen(session.id, true);
    const assembled = assembleSessions().find((s) => s.id === session.id) ?? null;
    jsonRes(res, existed ? 200 : 201, { id: session.id, existed, session: assembled });
  } catch (err) {
    jsonRes(res, err.status ?? 500, { error: err.message });
  }
}

// POST /sessions/:id/close — tab close = kill PTYs + UNPIN (openedInDevEnv:false)
// but KEEP the record so the session stays in History and can be resumed. (DELETE
// /sessions/:id is the separate "truly remove + drop the git worktree" path.) A
// late dying-claude hook only updates lastStatus on the kept record; it never
// re-pins, so the tab stays closed.
async function handleCloseSession(req, res, sessionId) {
  try {
    killSessionPtys(sessionId, { forget: true });
    const unpinned = await setSessionOpen(sessionId, false);
    jsonRes(res, 200, { ok: true, id: sessionId, unpinned });
  } catch (err) {
    jsonRes(res, err.status ?? 500, { error: err.message });
  }
}

// DELETE /sessions/:id/ptys/:role — close a single pane's PTY. The closed
// marker is server-side state so other connected clients' lazy shell-spawn
// cannot resurrect a pane the user just closed.
async function handleKillPty(req, res, sessionId, role) {
  const existed = killPty(ptyIdFor(sessionId, role), { forget: true });
  // Only the claude pane carries a server-side closed marker (it gates the
  // take-over overlay). Closing a shell terminal just drops it from the deck.
  if (role === "claude") await setPaneClosed(sessionId, role, true);
  jsonRes(res, 200, { ok: true, existed });
}

async function handleCleanup(req, res) {
  try {
    const result = await cleanupState();
    for (const row of result.removed) {
      if (row.id) killSessionPtys(row.id, { forget: true });
    }
    jsonRes(res, 200, { ok: true, ...result });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleHook(req, res, queryParams = {}) {
  const body = await readBody(req);
  const event = String(queryParams.event || body?.event || body?.hook_event_name || "");
  const result = await applyHookEvent(event, body);
  if (result.ok === false) return jsonRes(res, 400, { error: result.error });
  jsonRes(res, 200, result);
}

// POST /worktrees — create + record + spawn BOTH PTYs before responding, so
// the new tab appears (with live panes) on the UI's next poll. The flat
// legacy fields stay top-level for gateway-passthrough compatibility; the
// assembled DevEnvSession rides along under `session`.
async function handleCreateWorktree(req, res) {
  const body = (await readBody(req)) || {};
  try {
    const created = await createWorktree(body);
    const sessionStub = { id: created.id, worktreePath: created.worktreePath };
    ensurePty({ session: sessionStub, role: "claude" });
    // Pin the worktree session as a tab so it survives a reboot like any other.
    await setSessionOpen(created.id, true);
    // No default shell terminal — opened on demand via the deck's + button.
    const session = assembleSessions().find((s) => s.id === created.id) ?? null;
    jsonRes(res, 201, { ...created, session });
  } catch (err) {
    jsonRes(res, err.status ?? 500, { error: err.message });
  }
}

async function handleListWorktrees(req, res, queryParams) {
  const repoPath = expandHome(queryParams.repoPath || "");
  if (!repoPath) return jsonRes(res, 400, { error: "repoPath required" });
  try {
    const worktrees = await listWorktreesEnriched(repoPath);
    jsonRes(res, 200, { worktrees, projectPath: repoPath });
  } catch (err) {
    jsonRes(res, 500, { error: err.message });
  }
}

async function handleListProjects(req, res, queryParams) {
  const devRoot = expandHome(queryParams.devRoot || (await readDevRoot()));
  try {
    jsonRes(res, 200, { devRoot, projects: listProjects(devRoot) });
  } catch (err) {
    jsonRes(res, 500, { error: `scan failed: ${err.message}` });
  }
}

async function handleGetDevRoot(req, res) {
  const root = await readDevRoot();
  jsonRes(res, 200, { devRoot: root, exists: existsSync(root) });
}

async function handlePatchDevRoot(req, res) {
  const body = await readBody(req);
  if (!body || typeof body.devRoot !== "string") {
    return jsonRes(res, 400, { error: "devRoot string required" });
  }
  const expanded = expandHome(body.devRoot);
  if (!expanded.startsWith("/")) {
    return jsonRes(res, 400, { error: "devRoot must be an absolute path" });
  }
  await writeDevRoot(expanded);
  jsonRes(res, 200, { devRoot: expanded, exists: existsSync(expanded) });
}

// Tab-monitoring exclusions (Dev Env → menu → Settings…). GET returns the
// effective patterns plus the baked defaults (so the UI can offer a reset);
// PUT replaces the list. Excluded cwds are not auto-created from hooks and are
// hidden from the tab list unless a terminal is live there.
function handleGetExcludes(req, res) {
  jsonRes(res, 200, { patterns: getExcludes(), defaults: DEFAULT_EXCLUDES });
}

async function handlePutExcludes(req, res) {
  const body = await readBody(req);
  if (!body || !Array.isArray(body.patterns)) {
    return jsonRes(res, 400, { error: "patterns array required" });
  }
  try {
    const saved = await saveExcludes(body.patterns);
    jsonRes(res, 200, { patterns: saved, defaults: DEFAULT_EXCLUDES });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ─────────────────────────── rich chat surface (/sessions/:id/claude/*)
// Backed by the claude PTY's headless mirror; same protocol as the gateway, so
// the shared @garrison/claude-chat component works against either.

function claudeRecFor(sessionId) {
  const rec = getPty(ptyIdFor(sessionId, "claude"));
  if (!rec || rec.state !== "running") return null;
  return rec;
}

function handleClaudeStream(req, res, sessionId) {
  const rec = claudeRecFor(sessionId);
  if (!rec) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.flushHeaders?.();
    res.write(`event: error\ndata: ${JSON.stringify({ message: "no running claude PTY" })}\n\n`);
    return;
  }
  openRichStream(mirrorHandle(rec), res);
}

function handleClaudeStatus(req, res, sessionId) {
  const rec = claudeRecFor(sessionId);
  if (!rec) return jsonRes(res, 409, { error: "no running claude PTY" });
  jsonRes(res, 200, richStatus(mirrorHandle(rec)));
}

function handleClaudeCommands(req, res, sessionId) {
  const found = findSessionById(sessionId);
  const cwd = found?.worktreePath;
  jsonRes(res, 200, { commands: enumerateCommandsCached(cwd ? { cwd } : {}) });
}

async function handleClaudeMessage(req, res, sessionId) {
  const rec = claudeRecFor(sessionId);
  if (!rec) return jsonRes(res, 409, { error: "no running claude PTY" });
  const body = (await readBody(req)) || {};
  const text = typeof body.text === "string" ? body.text : typeof body.message === "string" ? body.message : "";
  if (!text.trim()) return jsonRes(res, 400, { error: "text required" });
  try {
    rec.pty.write(text);
    const delayMs = Number.isFinite(body.delayMs) ? Math.max(0, Math.min(5000, body.delayMs)) : 600;
    await sleep(delayMs);
    rec.pty.write("\r");
    jsonRes(res, 202, { ack: true });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleClaudeKeys(req, res, sessionId) {
  const rec = claudeRecFor(sessionId);
  if (!rec) return jsonRes(res, 409, { error: "no running claude PTY" });
  const body = (await readBody(req)) || {};
  const seq = keySequence(String(body.key ?? ""));
  if (!seq) return jsonRes(res, 400, { error: "unknown key" });
  try { rec.pty.write(seq); } catch {}
  jsonRes(res, 200, { ok: true });
}

async function handleClaudeMode(req, res, sessionId) {
  const rec = claudeRecFor(sessionId);
  if (!rec) return jsonRes(res, 409, { error: "no running claude PTY" });
  const body = (await readBody(req)) || {};
  const result = await cycleMode(mirrorHandle(rec), String(body.mode ?? ""), (b) => {
    try { rec.pty.write(b); } catch {}
  });
  jsonRes(res, 200, result);
}

function handleClaudeInterrupt(req, res, sessionId) {
  const rec = claudeRecFor(sessionId);
  if (!rec) return jsonRes(res, 409, { error: "no running claude PTY" });
  try { rec.pty.write("\x1b"); } catch {}
  jsonRes(res, 200, { ok: true });
}

// ─────────────────────────── voice proxy (/voice/* and /sessions/:id/voice/*)
// Thin same-origin bridge to the deepgram-voice fitting (port 7085) so the
// browser never needs to cross-origin to it. The voice URL is rediscovered from
// the status file on EVERY request (the port can change / the fitting can come
// and go); if the file is missing or its /health fails we return 503 with a
// clear body and the UI disables voice. The Deepgram API key stays server-side
// in the voice fitting — this proxy only forwards bytes.

async function readVoiceUrl() {
  const raw = await readFile(VOICE_STATUS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.url !== "string") throw new Error("voice status file invalid");
  return parsed.url.replace(/\/$/, "");
}

async function readRawBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("payload too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// GET /voice/health -> { available, url?, keyConfigured? }. Never throws to the
// client: any failure (no status file, fitting down, key missing) collapses to
// available:false so the UI degrades gracefully.
async function handleVoiceHealth(req, res) {
  let voiceUrl;
  try {
    voiceUrl = await readVoiceUrl();
  } catch {
    return jsonRes(res, 200, { available: false });
  }
  try {
    const probe = await fetch(`${voiceUrl}/health`, { signal: AbortSignal.timeout(2500) });
    if (!probe.ok) return jsonRes(res, 200, { available: false, url: voiceUrl });
    const h = await probe.json().catch(() => ({}));
    return jsonRes(res, 200, {
      available: true,
      url: voiceUrl,
      keyConfigured: h.keyConfigured !== false
    });
  } catch {
    return jsonRes(res, 200, { available: false, url: voiceUrl });
  }
}

// POST /voice/tts -> forward JSON {text,format?} to <voiceUrl>/tts, stream the
// audio bytes back with the upstream content-type.
async function handleVoiceTts(req, res) {
  let voiceUrl;
  try { voiceUrl = await readVoiceUrl(); }
  catch { return jsonRes(res, 503, { error: "voice fitting not running" }); }
  let body;
  try { body = await readRawBody(req, 1 * 1024 * 1024); }
  catch (err) { return jsonRes(res, 400, { error: `bad body: ${err.message}` }); }
  try {
    const up = await fetch(`${voiceUrl}/tts`, {
      method: "POST",
      headers: { "content-type": req.headers["content-type"] || "application/json" },
      body,
      // Bounded: a hung voice fitting must not hang this request forever.
      signal: AbortSignal.timeout(20000)
    });
    const buf = Buffer.from(await up.arrayBuffer());
    if (!up.ok) {
      // Bubble the upstream status (e.g. 503 = key missing) and body verbatim.
      res.statusCode = up.status;
      res.setHeader("Content-Type", up.headers.get("content-type") || "application/json");
      return res.end(buf);
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", up.headers.get("content-type") || "audio/mpeg");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "no-store");
    res.end(buf);
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    jsonRes(res, timedOut ? 504 : 502, { error: `voice tts ${timedOut ? "timed out" : "failed"}: ${err.message}` });
  }
}

// POST /voice/stt -> forward raw audio bytes to <voiceUrl>/stt, return the JSON
// { transcript, confidence }.
async function handleVoiceStt(req, res) {
  let voiceUrl;
  try { voiceUrl = await readVoiceUrl(); }
  catch { return jsonRes(res, 503, { error: "voice fitting not running" }); }
  let body;
  try { body = await readRawBody(req); }
  catch (err) { return jsonRes(res, 400, { error: `bad audio body: ${err.message}` }); }
  try {
    const up = await fetch(`${voiceUrl}/stt`, {
      method: "POST",
      headers: { "content-type": req.headers["content-type"] || "audio/webm" },
      body,
      // Bounded: a hung voice fitting must not hang this request forever.
      signal: AbortSignal.timeout(20000)
    });
    const text = await up.text();
    res.statusCode = up.status;
    res.setHeader("Content-Type", up.headers.get("content-type") || "application/json");
    res.end(text);
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    jsonRes(res, timedOut ? 504 : 502, { error: `voice stt ${timedOut ? "timed out" : "failed"}: ${err.message}` });
  }
}

function serveStatic(req, res, distDir) {
  let pathname = url.parse(req.url).pathname || "/";
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(distDir, pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(distDir)) { res.statusCode = 403; return res.end("forbidden"); }
  if (!existsSync(filePath)) {
    const idx = path.join(distDir, "index.html");
    if (existsSync(idx)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      return res.end(readFileSync(idx));
    }
    res.statusCode = 404;
    return res.end("not found");
  }
  const ext = path.extname(filePath).toLowerCase();
  const ct = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
  res.statusCode = 200;
  res.setHeader("Content-Type", ct[ext] ?? "application/octet-stream");
  createReadStream(filePath).pipe(res);
}

async function findFreePort(startPort) {
  const net = await import("node:net");
  for (let port = startPort; port < startPort + 50; port++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  return null;
}

async function writeStatusFile(opts) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({
    fittingId: FITTING_ID,
    port: opts.port,
    url: `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString()
  }, null, 2));
}

async function clearStatusFile() {
  try { await unlink(STATUS_FILE); } catch {}
}

function rawSessionIds() {
  const ids = new Set();
  const state = readStateFile();
  if (!state) return ids;
  for (const project of Object.values(state.projects ?? {})) {
    for (const session of Object.values(project?.sessions ?? {})) {
      if (session?.id) ids.add(session.id);
    }
  }
  return ids;
}

export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, "..", "dist");
  setDefaultShell(opts.defaultShell);
  setDirtyCheckTtl(opts.dirtyTtlMs);
  const tmuxOn = resolveTmuxMode(opts.useTmux);
  setTmuxMode(tmuxOn);
  console.log(`[dev-env] PTY backing: ${tmuxOn ? "tmux (sessions survive restarts)" : "node-pty (direct)"}`);
  console.log(`[dev-env] tab exclusions: ${loadExcludes().length} pattern(s) active`);
  const free = await findFreePort(opts.port);
  if (free === null) { console.error(`[dev-env] no free port from ${opts.port}`); process.exit(1); }
  const liveOpts = { ...opts, port: free };
  if (free !== DEFAULT_PORT) {
    // The installed Claude Code hooks curl the port baked at install time
    // (inherited limitation of the hook contract).
    console.warn(`[dev-env] live port ${free} differs from default ${DEFAULT_PORT} — installed hooks still POST to the baked port`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      // CORS for cross-fitting calls (gateway passthrough, browser fitting)
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";

      // Mutations require same-origin (or no Origin, i.e. non-browser).
      if (method !== "GET" && !originAllowed(req)) {
        return jsonRes(res, 403, { error: "cross-origin mutation rejected" });
      }

      if (pathname === "/health") return handleHealth(req, res, liveOpts);
      if (pathname === "/sessions" && method === "GET") return handleListSessions(req, res);
      if (pathname === "/sessions" && method === "POST") return await handleCreateSession(req, res);
      if (pathname === "/sessions/cleanup" && method === "POST") return await handleCleanup(req, res);
      if (pathname === "/sessions/agents" && method === "GET") return handleListAgents(req, res);
      if (pathname === "/sessions/history" && method === "GET") return handleListHistory(req, res, parsed.query);
      if (pathname === "/sessions/open" && method === "POST") return await handleOpenSession(req, res);
      if (pathname === "/_hook" && method === "POST") return await handleHook(req, res, parsed.query);
      if (pathname === "/projects" && method === "GET") return await handleListProjects(req, res, parsed.query);
      if (pathname === "/dev-root" && method === "GET") return await handleGetDevRoot(req, res);
      if (pathname === "/dev-root" && method === "PATCH") return await handlePatchDevRoot(req, res);
      if (pathname === "/settings/excludes" && method === "GET") return handleGetExcludes(req, res);
      if (pathname === "/settings/excludes" && method === "PUT") return await handlePutExcludes(req, res);
      if (pathname === "/tailscale-ip" && method === "GET") return handleTailscaleIp(req, res);
      if (pathname === "/app-port" && method === "GET") return await handleAppPort(req, res, parsed.query);
      if (pathname === "/browser-target" && method === "GET") return await handleBrowserTarget(req, res);

      // Voice proxy. Accept it both bare (/voice/*) and under the chat
      // transport's session prefix (/sessions/:id/voice/*) — the session id is
      // irrelevant to voice; it's just the base path the rich chat posts under.
      const voiceMatch = pathname.match(/^(?:\/sessions\/[^/]+)?\/voice\/(health|tts|stt)$/);
      if (voiceMatch) {
        const action = voiceMatch[1];
        if (action === "health" && method === "GET") return await handleVoiceHealth(req, res);
        if (action === "tts" && method === "POST") return await handleVoiceTts(req, res);
        if (action === "stt" && method === "POST") return await handleVoiceStt(req, res);
      }

      if (pathname === "/worktrees" && method === "GET") return await handleListWorktrees(req, res, parsed.query);
      if (pathname === "/worktrees" && method === "POST") return await handleCreateWorktree(req, res);

      const wtDelMatch = pathname.match(/^\/worktrees\/([^/]+)$/);
      if (wtDelMatch && method === "DELETE") return await handleDeleteSession(req, res, decodeURIComponent(wtDelMatch[1]));

      const ptyKillMatch = pathname.match(/^\/sessions\/([^/]+)\/ptys\/(claude|shell(?:-\d+)?)$/);
      if (ptyKillMatch && method === "DELETE") {
        return await handleKillPty(req, res, decodeURIComponent(ptyKillMatch[1]), ptyKillMatch[2]);
      }

      const ptysMatch = pathname.match(/^\/sessions\/([^/]+)\/ptys$/);
      if (ptysMatch && method === "POST") return await handleEnsurePty(req, res, decodeURIComponent(ptysMatch[1]));

      const newTermMatch = pathname.match(/^\/sessions\/([^/]+)\/terminals$/);
      if (newTermMatch && method === "POST") return await handleCreateTerminal(req, res, decodeURIComponent(newTermMatch[1]));

      const closeMatch = pathname.match(/^\/sessions\/([^/]+)\/close$/);
      if (closeMatch && method === "POST") return await handleCloseSession(req, res, decodeURIComponent(closeMatch[1]));

      const instructMatch = pathname.match(/^\/sessions\/([^/]+)\/instruct$/);
      if (instructMatch && method === "POST") return await handleInstruct(req, res, decodeURIComponent(instructMatch[1]));

      // Rich chat surface over the claude PTY mirror.
      const claudeMatch = pathname.match(/^\/sessions\/([^/]+)\/claude\/([a-z]+)$/);
      if (claudeMatch) {
        const sid = decodeURIComponent(claudeMatch[1]);
        const action = claudeMatch[2];
        if (action === "stream" && method === "GET") return handleClaudeStream(req, res, sid);
        if (action === "status" && method === "GET") return handleClaudeStatus(req, res, sid);
        if (action === "commands" && method === "GET") return handleClaudeCommands(req, res, sid);
        if (action === "message" && method === "POST") return await handleClaudeMessage(req, res, sid);
        if (action === "keys" && method === "POST") return await handleClaudeKeys(req, res, sid);
        if (action === "mode" && method === "POST") return await handleClaudeMode(req, res, sid);
        if (action === "interrupt" && method === "POST") return handleClaudeInterrupt(req, res, sid);
      }

      const sessDelMatch = pathname.match(/^\/sessions\/([^/]+)$/);
      if (sessDelMatch && method === "DELETE") return await handleDeleteSession(req, res, decodeURIComponent(sessDelMatch[1]));

      return serveStatic(req, res, distDir);
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // WebSocket: /io — init.sessionId names a PTY id (<sessionId>-<role>).
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = url.parse(request.url || "/");
    if (pathname !== "/io") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws) => {
    let ptyId = null;
    ws.on("message", (data, isBinary) => {
      if (!ptyId) {
        // expect init frame as JSON
        let msg;
        try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
        if (msg.type === "init" && typeof msg.sessionId === "string") {
          const rec = getPty(msg.sessionId);
          if (!rec) {
            try { ws.send(JSON.stringify({ type: "error", message: "session not found" })); } catch {}
            ws.close();
            return;
          }
          rec.ws = ws;
          ptyId = rec.id;
          // Size the PTY to the connecting client BEFORE replaying. The init
          // frame carries the client's cols/rows; ignoring them left the PTY
          // (and, under tmux, its window) at the previous/spawn width, so
          // Claude's full-width boxes were drawn wider than the xterm viewport
          // and wrapped — the stray border dashes at the start of lines. With
          // tmux `window-size latest`, resizing the attach client repaints the
          // pane at the right width.
          if (Number.isFinite(msg.cols) && Number.isFinite(msg.rows) && msg.cols > 0 && msg.rows > 0) {
            resizePty(rec, Math.floor(msg.cols), Math.floor(msg.rows));
          }
          try {
            // `tmux: true` tells the client to stop converting wheel→arrows
            // (the outer xterm is permanently in the alternate screen under
            // tmux); tmux's own mouse mode scrolls the pane history instead.
            ws.send(JSON.stringify({ type: "init_ack", id: rec.id, cwd: rec.cwd, shell: rec.shell, tmux: isTmuxMode() }));
            if (rec.buffer.length > 0) ws.send(rec.buffer);
          } catch {}
        }
        return;
      }

      const rec = getPty(ptyId);
      if (!rec || rec.state !== "running") return;

      if (isBinary) {
        // stdin bytes (binary frame)
        try { rec.pty.write(data.toString("utf8")); rec.lastActivity = Date.now(); } catch {}
        return;
      }

      // Text frame: either a JSON control frame or raw stdin
      const text = data.toString("utf8");
      let frame = null;
      if (text.startsWith("{")) {
        try { frame = JSON.parse(text); } catch {}
      }
      if (frame && typeof frame === "object" && typeof frame.type === "string") {
        if (frame.type === "resize" && Number.isFinite(frame.cols) && Number.isFinite(frame.rows)) {
          resizePty(rec, frame.cols, frame.rows);
        } else if (frame.type === "ping") {
          try { ws.send(JSON.stringify({ type: "pong", ts: Date.now() })); } catch {}
        } else if (frame.type === "stdin" && typeof frame.data === "string") {
          try { rec.pty.write(frame.data); rec.lastActivity = Date.now(); } catch {}
        }
        return;
      }
      // Raw text stdin
      try { rec.pty.write(text); rec.lastActivity = Date.now(); } catch {}
    });

    ws.on("close", () => {
      if (!ptyId) return;
      const rec = getPty(ptyId);
      if (!rec || rec.ws !== ws) return;
      // PTYs are persistent: just detach. No reap timer — the PTY lives
      // until session delete/cleanup or server shutdown.
      rec.ws = null;
    });
  });

  // Eagerly restore persisted PTYs before accepting traffic so the first
  // /sessions response already carries replayed shells + parked claudes.
  const restored = await rehydratePtys(rawSessionIds());
  if (restored > 0) console.log(`[dev-env] restored ${restored} persisted PTY(s)`);

  // One-time open-set migration: records that predate openedInDevEnv are seeded
  // from the OLD visibility (live / has a restored PTY / recently active was a
  // visible tab → keep it open). After this every record carries the flag, so
  // the tab strip is rebuilt from persistence — surviving a reboot.
  const migrated = await migrateOpenSet((session) => {
    if (hasLiveClaudeProcess(session.worktreePath, session.claudeSessionId)) return true;
    if (ptySummary(session.id, "claude").state === "running") return true;
    const t = Date.parse(session.lastStatusAt || "");
    return Number.isFinite(t) && Date.now() - t < 90 * 60 * 1000;
  });
  if (migrated > 0) console.log(`[dev-env] migrated ${migrated} session(s) into the open-set`);

  await new Promise((resolve) => {
    server.listen(liveOpts.port, liveOpts.host, async () => {
      await writeStatusFile(liveOpts);
      console.log(`[dev-env] listening on http://${liveOpts.host}:${liveOpts.port}`);
      resolve();
    });
  });

  // working → idle fallback timer
  const fallbackTimer = setInterval(() => { void runWorkingIdleFallback(liveBusySessionIds()); }, 5000);
  fallbackTimer.unref?.();

  const shutdown = async (signal) => {
    console.log(`[dev-env] shutdown (${signal})`);
    // Land pending view-state writes while the ptys (and their buffers) are
    // still alive — this is what makes sessions survive the restart.
    await shutdownPtys();
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
  try { return path.resolve(url.fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || ""); } catch { return false; }
})();

if (isDirect) {
  startServer().catch((err) => { console.error("[dev-env] failed:", err); process.exit(1); });
}
