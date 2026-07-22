// Kanban terminal PTY manager — a trimmed port of dev-env/scripts/ptys.mjs.
// One shell PTY per card (id = `card-<cardId>-shell`), opened at the card's
// project cwd. Dropped from the donor: tmux mode, view-state persistence, the
// @xterm/headless mirror, claude parking/liveness, probeCwd, and claudeCommand.
// Kept: the output ring buffer with replay, onData→ws forwarding, onExit, and
// the UTF-8 locale + TERM env that keeps TUI glyphs rendering correctly.
//
// PTYs are process-lifetime persistent: they are NOT reaped when a ws detaches
// (we just null rec.ws), only on explicit killPty or server shutdown. Keyed in
// a Map by id.

import { existsSync } from "node:fs";
import pty from "node-pty";

// Big enough to replay a full alt-screen redraw (vim, less, a long build log)
// on a genuine reconnect.
const OUTPUT_BUFFER_BYTES = 512 * 1024;

const ptys = new Map(); // id -> record

let shuttingDown = false;
let defaultShell = process.env.SHELL || "/bin/zsh";

export function setDefaultShell(shell) {
  if (shell && typeof shell === "string") defaultShell = shell;
}

// Claude Code (and other TUIs) decide whether the terminal can render their
// fancy glyphs (⏺ ⎿ ⏵ ❯ …) from the locale, NOT from TERM. When Garrison is
// launched without LANG/LC_*, a TUI treats the terminal as non-UTF-8 and falls
// back to ASCII — the stray dashes at line starts. Ensure a UTF-8 locale; only
// fill the gap when the environment doesn't already declare one.
const UTF8_LOCALE = "en_US.UTF-8";
function withUtf8Locale(env) {
  const isUtf8 = (v) => typeof v === "string" && /utf-?8/i.test(v);
  if (isUtf8(env.LC_ALL) || isUtf8(env.LC_CTYPE) || isUtf8(env.LANG)) return env;
  return { ...env, LANG: UTF8_LOCALE, LC_CTYPE: UTF8_LOCALE };
}

// Spawn (or return the live) shell PTY for `id` at `cwd`. A record already
// running is returned as-is; an exited record is replaced.
export function spawnPty({ id, cwd, shell }) {
  const existing = ptys.get(id);
  if (existing && existing.state === "running") return existing;
  if (existing?.ws && existing.ws.readyState === 1) {
    try { existing.ws.close(); } catch {}
  }

  const finalShell = shell || defaultShell;
  const finalCwd = cwd && existsSync(cwd) ? cwd : process.env.HOME || "/tmp";
  const spawnEnv = withUtf8Locale({ ...process.env, TERM: "xterm-256color" });

  const term = pty.spawn(finalShell, ["-l"], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: finalCwd,
    env: spawnEnv
  });

  const rec = {
    id,
    cwd: finalCwd,
    shell: finalShell,
    pty: term,
    ws: null,
    state: "running",
    exitCode: null,
    lastActivity: Date.now(),
    createdAt: new Date().toISOString(),
    buffer: Buffer.alloc(0)
  };

  term.onData((data) => {
    rec.lastActivity = Date.now();
    const buf = Buffer.from(data, "utf8");
    rec.buffer = Buffer.concat([rec.buffer, buf]).slice(-OUTPUT_BUFFER_BYTES);
    if (rec.ws && rec.ws.readyState === 1) {
      try { rec.ws.send(buf); } catch {}
    }
  });

  term.onExit(({ exitCode, signal }) => {
    rec.state = "exited";
    rec.exitCode = exitCode;
    if (rec.ws && rec.ws.readyState === 1) {
      try { rec.ws.send(JSON.stringify({ type: "exit", exitCode, signal })); } catch {}
    }
    // Keep the record (exited state, buffer retained) until an explicit killPty
    // or a fresh spawnPty replaces it.
  });

  ptys.set(id, rec);
  return rec;
}

export function getPty(id) {
  return ptys.get(id) ?? null;
}

export function resizePty(rec, cols, rows) {
  if (!rec) return;
  try { rec.pty.resize(cols, rows); } catch {}
}

export function killPty(id) {
  const rec = ptys.get(id);
  if (!rec) return false;
  if (rec.state === "running") {
    try { rec.pty.kill(); } catch {}
  }
  if (rec.ws && rec.ws.readyState === 1) {
    try { rec.ws.close(); } catch {}
  }
  rec.state = "exited";
  ptys.delete(id);
  return true;
}

export function listPtys() {
  return [...ptys.values()];
}

// Shutdown path: kill every live shell. No persistence to land (view-state was
// dropped), so this is a straight teardown.
export function shutdownPtys() {
  shuttingDown = true;
  for (const rec of ptys.values()) {
    if (rec.state === "running") {
      try { rec.pty.kill(); } catch {}
    }
  }
  ptys.clear();
}

export function isShuttingDown() {
  return shuttingDown;
}
