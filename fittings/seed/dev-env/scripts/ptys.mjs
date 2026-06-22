// dev-env PTY manager — ported from terminal-armory-default scripts/server.mjs
// (the PTY/session half) with the Dev Env contract changes:
//   - Deterministic ids: <sessionId>-claude / <sessionId>-shell, where
//     sessionId is the state.json session UUID. The session↔PTY mapping
//     therefore needs no separate persistence.
//   - PTYs are PERSISTENT: no detach reap on ws close — a PTY lives until
//     session delete/cleanup or server shutdown.
//   - onExit keeps the record (state:"exited", exitCode, buffer retained)
//     instead of deleting it; only killPty(id, {forget:true}) removes
//     view-state.
//   - Rehydration: shell envelopes respawn fresh at the restored cwd with
//     scrollback replay (donor behavior); claude envelopes are PARKED, not
//     spawned — the UI offers one-tap Resume (claude --continue), which
//     pre-loads the persisted scrollback into the new buffer.

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import url from "node:url";
import pty from "node-pty";
import xtermHeadless from "@xterm/headless";

// @xterm/headless v6 is CJS with a default export; pull Terminal off it.
const HeadlessTerminal = xtermHeadless.Terminal;
import {
  deleteInstance,
  cancelInstanceWrite,
  flushInstanceWrites,
  readAllInstances,
  scheduleInstanceWrite
} from "./view-state.mjs";
import {
  attachOrCreateArgs,
  isShellCommand,
  listGarrisonSessions,
  sessionIdRoleFromName,
  tmuxHasSession,
  tmuxKillSession,
  tmuxPaneCommand,
  tmuxSessionName
} from "./tmux.mjs";

const FITTING_ID = "dev-env";
// Big enough to replay a full alt-screen redraw (Claude Code, vim, less etc.)
// on genuine reconnect.
const OUTPUT_BUFFER_BYTES = 512 * 1024;
const PERSIST_SCROLLBACK_BYTES = 128 * 1024;
const CLAUDE_ALIVE_TTL_MS = 5000;
// Grace period after spawn before pgrep verdicts are believed — the claude
// command is only written into the shell 250ms after spawn.
const CLAUDE_ALIVE_GRACE_MS = 3000;

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(HERE, "..", "prompts", "browser-pane.md");

// `claude` is the agent PTY (gets a headless mirror + liveness checks). Every
// other role is a plain shell terminal: the legacy first one is `shell` and
// additional terminals are `shell-2`, `shell-3`, … — a session can hold any
// number of them, each a leaf in the UI's tiling deck.
export const PTY_ROLES = ["claude", "shell"];

// Numeric index of a shell role (`shell` → 1, `shell-7` → 7). 0 for claude /
// anything unparseable. Drives next-free allocation and stable ordering.
function shellRoleIndex(role) {
  if (role === "shell") return 1;
  const m = /^shell-(\d+)$/.exec(role);
  return m ? Number(m[1]) : 0;
}

const ptys = new Map(); // ptyId -> record
const parked = new Map(); // ptyId -> persisted claude envelope state (never spawned)

let shuttingDown = false;
let defaultShell = process.env.SHELL || "/bin/zsh";

// When true, each PTY's node-pty child is a `tmux attach` client rather than
// the shell itself — the shell/claude live in the tmux server and survive a
// restart of this process. Resolved once at startup (see setTmuxMode). When
// false the legacy direct-spawn path (and its view-state scrollback persistence
// + claude parking) is used unchanged.
let tmuxMode = false;

export function setTmuxMode(on) {
  tmuxMode = Boolean(on);
}

export function isTmuxMode() {
  return tmuxMode;
}

export function setDefaultShell(shell) {
  if (shell && typeof shell === "string") defaultShell = shell;
}

export function ptyIdFor(sessionId, role) {
  return `${sessionId}-${role}`;
}

// Pick the next free shell role for a session — the smallest unused index so a
// closed terminal's slot is reused before growing. `shell` (index 1) first,
// then `shell-2`, `shell-3`, … Considers both live and parked records.
export function allocateTerminalRole(sessionId) {
  const used = new Set();
  for (const rec of ptys.values()) {
    if (rec.sessionId === sessionId && rec.role !== "claude") used.add(shellRoleIndex(rec.role));
  }
  for (const id of parked.keys()) {
    const m = /^(.+)-(shell(?:-\d+)?)$/.exec(id);
    if (m && m[1] === sessionId) used.add(shellRoleIndex(m[2]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return n === 1 ? "shell" : `shell-${n}`;
}

// Summaries of every shell terminal (running or exited) for a session, ordered
// by creation so the UI deck appends newest last. Claude is reported
// separately via ptySummary(id, "claude").
export function listSessionTerminals(sessionId) {
  const out = [];
  for (const rec of ptys.values()) {
    if (rec.sessionId !== sessionId || rec.role === "claude") continue;
    out.push({
      id: rec.id,
      role: rec.role,
      index: shellRoleIndex(rec.role),
      state: rec.state,
      exitCode: rec.exitCode,
      createdAt: rec.createdAt
    });
  }
  out.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
  return out;
}

// The append prompt teaches Claude to drive the side-by-side browser pane via
// the garrison-browser CLI. No full system prompt replacement — just append.
// A Claude session id is a UUID. We allow ONLY that charset so the value is safe
// to splice into the shell command the PTY runs — JSON.stringify is NOT a shell
// escape (it leaves `$()`/backticks live inside double quotes), so an unsanitised
// id would be a command-injection vector. An id that fails this is ignored
// (falls back to --continue / fresh) rather than executed.
const SAFE_SESSION_ID = /^[0-9a-fA-F-]{8,64}$/;

export function claudeCommand({ resume = false, resumeId = null } = {}) {
  // Default dev-env sessions to "auto" rather than bypassing permissions: the
  // dev-env terminal is a real interactive TUI, so the user can answer prompts.
  // shift+tab still cycles to bypass when wanted.
  const parts = ["claude", "--permission-mode", "auto"];
  // resumeId resumes that EXACT conversation by id — required after a reboot (so
  // the restored tab re-attaches its own session, not whatever ran most recently
  // in the cwd) and when a cwd holds several sessions. `--continue` is the
  // most-recent-in-cwd fallback used when we have no specific id.
  const safeId = resumeId != null && SAFE_SESSION_ID.test(String(resumeId)) ? String(resumeId) : null;
  if (safeId) parts.push("--resume", safeId); // UUID charset → no shell metachars, no quoting needed
  else if (resume) parts.push("--continue");
  parts.push("--append-system-prompt-file", JSON.stringify(PROMPT_PATH));
  return parts.join(" ");
}

// Live cwd of the shell (the user cds around) — best-effort via lsof, falling
// back to the spawn cwd. Runs only at debounced-persist time, never per-write.
function probeCwd(rec) {
  return new Promise((resolve) => {
    const pid = rec.pty?.pid;
    if (typeof pid !== "number" || rec.state !== "running") return resolve(null);
    execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 1500 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).split("\n").find((l) => l.startsWith("n"));
      resolve(line ? line.slice(1) : null);
    });
  });
}

function persistPty(rec) {
  // In tmux mode the durable scrollback authority is the tmux server, and
  // rehydration reconciles from `tmux list-sessions` — so the disk view-state
  // envelope (a 128 KB base64 write on every burst of output) is dead weight.
  if (tmuxMode) return;
  // `forgotten` blocks the final onData flush of a killed PTY from
  // re-creating the envelope after killPty's deleteInstance.
  if (shuttingDown || rec.forgotten) return;
  scheduleInstanceWrite(FITTING_ID, rec.id, async () => ({
    role: rec.role,
    sessionId: rec.sessionId,
    cwd: (await probeCwd(rec)) || rec.cwd,
    shell: rec.shell,
    command: rec.command || null,
    createdAt: rec.createdAt,
    scrollbackB64: rec.buffer.slice(-PERSIST_SCROLLBACK_BYTES).toString("base64")
  }));
}

function refreshClaudeAlive(rec) {
  if (rec.role !== "claude" || rec.state !== "running") return;
  const now = Date.now();
  if (now - rec.spawnedAtMs < CLAUDE_ALIVE_GRACE_MS) return;
  if (rec.claudeCheckedAt && now - rec.claudeCheckedAt < CLAUDE_ALIVE_TTL_MS) return;
  rec.claudeCheckedAt = now;
  if (tmuxMode) {
    // Under tmux, claude is a child of the tmux server (not our attach client),
    // so pgrep -P would never see it. The pane's foreground command is the
    // truth: anything that isn't a plain shell means claude is running.
    // A null read (transient tmux error) leaves the prior verdict untouched.
    tmuxPaneCommand(rec.tmuxSession).then((cmd) => {
      if (rec.state !== "running") return;
      if (cmd !== null) rec.claudeAlive = !isShellCommand(cmd);
    });
    return;
  }
  execFile("pgrep", ["-P", String(rec.pty.pid), "-f", "claude"], { timeout: 1500 }, (err, stdout) => {
    if (rec.state !== "running") return;
    rec.claudeAlive = !err && String(stdout).trim().length > 0;
  });
}

// Claude Code (and other TUIs) decide whether the terminal can render their
// fancy glyphs (⏺ ⎿ ⏵ ❯ …) from the locale, NOT from TERM. When Garrison is
// launched by launchd it inherits no LANG/LC_*, so claude treats the terminal
// as non-UTF-8 and falls back to ASCII — the glyphs come out as bare "_", the
// stray dashes the user sees at the start of lines and in the prompt box.
// Ensure a UTF-8 locale so the real glyphs are used; only fill the gap when the
// environment doesn't already declare one.
const UTF8_LOCALE = "en_US.UTF-8";
function withUtf8Locale(env) {
  const isUtf8 = (v) => typeof v === "string" && /utf-?8/i.test(v);
  if (isUtf8(env.LC_ALL) || isUtf8(env.LC_CTYPE) || isUtf8(env.LANG)) return env;
  return { ...env, LANG: UTF8_LOCALE, LC_CTYPE: UTF8_LOCALE };
}

export function spawnPty({ sessionId, role, cwd, shell, command, restoredScrollbackB64, restoredMarker }) {
  const id = ptyIdFor(sessionId, role);
  const existing = ptys.get(id);
  if (existing && existing.state === "running") return existing;
  if (existing?.ws && existing.ws.readyState === 1) {
    try { existing.ws.close(); } catch {}
  }
  parked.delete(id);

  const finalShell = shell || defaultShell;
  const finalCwd = cwd && existsSync(cwd) ? cwd : process.env.HOME || "/tmp";

  const spawnEnv = withUtf8Locale({ ...process.env, TERM: "xterm-256color" });
  // tmux panes run under the (possibly already-running) tmux server's
  // environment, which may predate this locale fix, so bake the locale straight
  // into the create command instead of relying on env inheritance.
  const localeAssign = ["LANG", "LC_CTYPE", "LC_ALL"]
    .filter((k) => spawnEnv[k])
    .map((k) => `${k}=${spawnEnv[k]}`)
    .join(" ");

  // tmux mode: spawn an attach-or-create client. The shell (`<shell> -l`) runs
  // inside the tmux server as the CREATE command; on a pre-existing session
  // this just re-attaches to the live pane. We record whether we created it so
  // the command-injection below (claude etc.) only fires on first create —
  // re-attaching must never relaunch claude over a running one.
  let tmuxSession = null;
  let createdTmuxSession = false;
  let term;
  if (tmuxMode) {
    tmuxSession = tmuxSessionName(id);
    createdTmuxSession = !tmuxHasSession(tmuxSession);
    term = pty.spawn("tmux", attachOrCreateArgs({
      name: tmuxSession,
      cwd: finalCwd,
      cols: 100,
      rows: 30,
      createCommand: `${localeAssign ? localeAssign + " " : ""}${finalShell} -l`
    }), {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: finalCwd,
      env: spawnEnv
    });
  } else {
    term = pty.spawn(finalShell, ["-l"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: finalCwd,
      env: spawnEnv
    });
  }

  // Claude PTYs get a headless xterm mirror so the rich chat view (Phase 2) can
  // read structured screen state (reply, status line, mode) off the same PTY
  // that the terminal view streams raw. Shell PTYs don't need it.
  // Mirror dims MUST track the PTY's (the browser terminal resizes it), else
  // the reconstructed screen mis-wraps. Start at the spawn dims; resizePty()
  // keeps them in sync.
  const mirror =
    role === "claude"
      ? new HeadlessTerminal({ cols: 100, rows: 30, allowProposedApi: true })
      : null;

  const rec = {
    id,
    sessionId,
    role,
    cwd: finalCwd,
    shell: finalShell,
    command: command && typeof command === "string" ? command : null,
    pty: term,
    mirror,
    tmuxSession,
    ws: null,
    state: "running",
    exitCode: null,
    lastActivity: Date.now(),
    createdAt: new Date().toISOString(),
    spawnedAtMs: Date.now(),
    buffer: Buffer.alloc(0),
    claudeAlive: role === "claude" ? true : undefined,
    claudeCheckedAt: 0
  };

  // tmux repaints the live screen on attach, so there is nothing to replay —
  // the scrollback restore path is legacy (direct-spawn) only.
  if (!tmuxMode && typeof restoredScrollbackB64 === "string" && restoredScrollbackB64) {
    const restored = Buffer.from(restoredScrollbackB64, "base64");
    const marker = Buffer.from(
      restoredMarker ?? `\r\n\x1b[2m[garrison: session restored — fresh shell at ${rec.cwd}]\x1b[0m\r\n`,
      "utf8"
    );
    rec.buffer = Buffer.concat([restored, marker]).slice(-OUTPUT_BUFFER_BYTES);
    if (rec.mirror) {
      try { rec.mirror.write(rec.buffer.toString("utf8")); } catch {}
    }
  }

  term.onData((data) => {
    rec.lastActivity = Date.now();
    const buf = Buffer.from(data, "utf8");
    rec.buffer = Buffer.concat([rec.buffer, buf]).slice(-OUTPUT_BUFFER_BYTES);
    if (rec.mirror) {
      try { rec.mirror.write(data); } catch {}
    }
    if (rec.ws && rec.ws.readyState === 1) {
      try { rec.ws.send(buf); } catch {}
    }
    persistPty(rec);
  });

  term.onExit(({ exitCode, signal }) => {
    rec.state = "exited";
    rec.exitCode = exitCode;
    if (rec.ws && rec.ws.readyState === 1) {
      try { rec.ws.send(JSON.stringify({ type: "exit", exitCode, signal })); } catch {}
    }
    // The record and its view-state envelope are retained — only an explicit
    // killPty(id, {forget:true}) (session delete / cleanup) removes them.
  });

  ptys.set(id, rec);
  persistPty(rec);

  // Inject the command (the claude launch line) by typing it into the shell,
  // 250ms after spawn so a slow login shell is ready. In tmux mode this fires
  // only on a freshly CREATED session — re-attaching lands on the already
  // running claude (or the shell it dropped back to), which must not be
  // clobbered with a second launch.
  if (rec.command && rec.command.trim() && (!tmuxMode || createdTmuxSession)) {
    setTimeout(() => {
      try { term.write(rec.command + "\r"); } catch {}
    }, 250);
  }

  return rec;
}

// Ensure a PTY exists (and is healthy) for the session+role. Handles:
//   running shell           -> returned as-is
//   running claude, dead cli-> re-write the claude command into the same shell
//   exited                  -> respawn fresh at cwd, old buffer replayed
//   parked claude envelope  -> spawn fresh with --continue + persisted scrollback
//   none                    -> spawn fresh (claude gets --continue iff resume)
export function ensurePty({ session, role, resume = false, resumeId = null }) {
  const id = ptyIdFor(session.id, role);
  const rec = ptys.get(id);

  if (rec && rec.state === "running") {
    if (role === "claude" && rec.claudeAlive === false) {
      const cmd = claudeCommand({ resume: true, resumeId });
      rec.command = cmd;
      rec.claudeAlive = true;
      rec.claudeCheckedAt = 0;
      rec.spawnedAtMs = Date.now();
      try { rec.pty.write(cmd + "\r"); } catch {}
    }
    return rec;
  }

  if (rec && rec.state === "exited") {
    const old = rec.buffer;
    ptys.delete(id);
    return spawnPty({
      sessionId: session.id,
      role,
      cwd: session.worktreePath,
      command: role === "claude" ? claudeCommand({ resume: true, resumeId }) : undefined,
      restoredScrollbackB64: old.length ? old.toString("base64") : undefined
    });
  }

  const envelope = parked.get(id);
  if (role === "claude" && envelope) {
    const verb = resumeId ? "claude --resume" : "claude --continue";
    return spawnPty({
      sessionId: session.id,
      role,
      cwd: session.worktreePath,
      command: claudeCommand({ resume: true, resumeId }),
      restoredScrollbackB64: typeof envelope.scrollbackB64 === "string" ? envelope.scrollbackB64 : undefined,
      restoredMarker: `\r\n\x1b[2m[garrison: resuming claude session — ${verb}]\x1b[0m\r\n`
    });
  }

  return spawnPty({
    sessionId: session.id,
    role,
    cwd: session.worktreePath,
    command: role === "claude" ? claudeCommand({ resume, resumeId }) : undefined
  });
}

export function getPty(id) {
  return ptys.get(id) ?? null;
}

// Resize the PTY and its headless mirror together so the rich view's screen
// reconstruction stays consistent with the terminal view.
export function resizePty(rec, cols, rows) {
  if (!rec) return;
  try { rec.pty.resize(cols, rows); } catch {}
  if (rec.mirror) {
    try { rec.mirror.resize(cols, rows); } catch {}
  }
}

// A screen.mjs-compatible handle over a claude PTY's mirror: { term, writeRaw }.
// Returns null for shell PTYs or claude PTYs without a mirror.
export function mirrorHandle(rec) {
  if (!rec || !rec.mirror) return null;
  return {
    term: rec.mirror,
    writeRaw: (bytes) => {
      try { rec.pty.write(bytes); rec.lastActivity = Date.now(); } catch {}
    }
  };
}

export function listPtys() {
  return [...ptys.values()];
}

export function listParked() {
  return [...parked.keys()];
}

export function ptySummary(sessionId, role) {
  const id = ptyIdFor(sessionId, role);
  const rec = ptys.get(id);
  if (rec) {
    refreshClaudeAlive(rec);
    const out = { id, state: rec.state, exitCode: rec.exitCode, createdAt: rec.createdAt };
    if (rec.role === "claude") out.claudeAlive = rec.claudeAlive !== false;
    return out;
  }
  if (parked.has(id)) return { id, state: "persisted" };
  return { state: "none" };
}

export function killPty(id, { forget = false } = {}) {
  const rec = ptys.get(id);
  if (rec) {
    if (forget) rec.forgotten = true;
    if (rec.state === "running") {
      try { rec.pty.kill(); } catch {}
    }
    if (rec.ws && rec.ws.readyState === 1) {
      try { rec.ws.close(); } catch {}
    }
    rec.state = "exited";
    ptys.delete(id);
  }
  if (forget) {
    parked.delete(id);
    cancelInstanceWrite(FITTING_ID, id);
    void deleteInstance(FITTING_ID, id).catch(() => {});
    // The attach client we just killed only detached the session — the durable
    // shell/claude lives in the tmux server. `forget` (pane/tab close, session
    // delete, orphan sweep) means really gone, so destroy the session too. The
    // ptyId resolves to a session name whether or not we had a live `rec`,
    // covering sessions that exist in tmux but were never attached here.
    if (tmuxMode) void tmuxKillSession(tmuxSessionName(id));
  }
  return Boolean(rec);
}

export function killSessionPtys(sessionId, { forget = false } = {}) {
  // A session can hold claude + any number of shell terminals, so enumerate the
  // live records (and parked claude envelopes) rather than a fixed role list.
  for (const rec of [...ptys.values()]) {
    if (rec.sessionId === sessionId) killPty(rec.id, { forget });
  }
  for (const id of [...parked.keys()]) {
    const m = /^(.+)-(claude|shell(?:-\d+)?)$/.exec(id);
    if (m && m[1] === sessionId) killPty(id, { forget });
  }
}

// Boot-time rehydration. `liveSessionIds` is the set of session UUIDs present
// in the RAW state file.
//
// tmux mode: tmux IS the durable store, so we reconcile against
// `tmux list-sessions` — re-attach to every garrison session whose record is
// still live (re-attaching connects to the running shell/claude; it does not
// relaunch anything), and kill sessions whose record vanished while we were
// down.
//
// legacy mode: envelopes for vanished sessions are orphans and get deleted.
// Shell envelopes respawn (fresh shell + scrollback replay); claude envelopes
// are parked for an explicit user Resume.
export async function rehydratePtys(liveSessionIds) {
  if (tmuxMode) return rehydrateTmux(liveSessionIds);
  let envelopes = [];
  try {
    envelopes = await readAllInstances(FITTING_ID);
  } catch (err) {
    console.error("[dev-env] view-state rehydrate scan failed:", err);
    return 0;
  }
  let restored = 0;
  for (const envelope of envelopes) {
    const st = envelope.state && typeof envelope.state === "object" ? envelope.state : {};
    const m = envelope.instanceId.match(/^(.+)-(claude|shell(?:-\d+)?)$/);
    const sessionId = m ? m[1] : (typeof st.sessionId === "string" ? st.sessionId : null);
    const role = m ? m[2] : (typeof st.role === "string" ? st.role : null);
    if (!sessionId || !role || !liveSessionIds.has(sessionId)) {
      void deleteInstance(FITTING_ID, envelope.instanceId).catch(() => {});
      continue;
    }
    if (role === "claude") {
      parked.set(envelope.instanceId, st);
      restored++;
      continue;
    }
    try {
      spawnPty({
        sessionId,
        role,
        cwd: typeof st.cwd === "string" ? st.cwd : undefined,
        shell: typeof st.shell === "string" ? st.shell : undefined,
        restoredScrollbackB64: typeof st.scrollbackB64 === "string" ? st.scrollbackB64 : undefined
      });
      restored++;
    } catch (err) {
      console.error(`[dev-env] rehydrate failed for ${envelope.instanceId}:`, err);
    }
  }
  return restored;
}

// Re-attach to live tmux sessions on boot; reap orphans whose record is gone.
async function rehydrateTmux(liveSessionIds) {
  const names = listGarrisonSessions();
  // Safety net against catastrophic restart loss. An EMPTY live set while tmux
  // sessions are alive does not mean "every session was closed" — closing a
  // session forgets its tmux session, so a clean shutdown leaves no orphans.
  // It means the session ledger (state.json) was missing, empty, or unreadable
  // at boot (a transient read failure, a half-written file). Reaping against an
  // untrustworthy ledger would kill in-flight work — exactly the "I restarted
  // and lost my sessions" failure. So when the ledger is empty we re-attach
  // everything parseable and reap nothing this pass; the ledger heals and the
  // next sweep handles any genuine orphan.
  const trustLedger = liveSessionIds.size > 0;
  if (!trustLedger && names.length > 0) {
    console.warn(
      `[dev-env] session ledger empty but ${names.length} tmux session(s) live — ` +
      "re-attaching all, reaping none (ledger unreadable/empty; not destroying work)"
    );
  }
  let restored = 0;
  for (const name of names) {
    const parsed = sessionIdRoleFromName(name);
    if (!parsed) {
      void tmuxKillSession(name); // unparseable junk name → always an orphan
      continue;
    }
    if (trustLedger && !liveSessionIds.has(parsed.sessionId)) {
      void tmuxKillSession(name); // record genuinely vanished while we were down
      continue;
    }
    try {
      // No command/scrollback: this re-attaches to the running pane. claude
      // (if it was running) is still running and shows on first repaint.
      spawnPty({ sessionId: parsed.sessionId, role: parsed.role });
      restored++;
    } catch (err) {
      console.error(`[dev-env] tmux re-attach failed for ${name}:`, err);
    }
  }
  return restored;
}

// Shutdown path. In tmux mode killing each node-pty only kills the ATTACH
// CLIENT — the session detaches and keeps running in the tmux server, which is
// exactly what makes the work survive this process dying; we re-attach on the
// next boot. In legacy mode this kills the real shells, so we first land
// pending view-state writes (scrollback) while the buffers are still alive.
export async function shutdownPtys() {
  shuttingDown = true;
  try { await flushInstanceWrites(); } catch {}
  for (const rec of ptys.values()) {
    if (rec.state === "running") {
      try { rec.pty.kill(); } catch {}
    }
  }
  ptys.clear();
}
