// Dedicated-socket tmux helpers for the dev-env Fitting.
//
// In tmux mode each PTY record's node-pty child is a `tmux attach` CLIENT
// (spawned via `new-session -A`), not the shell/claude itself. The shell and
// claude run inside the tmux SERVER — an independent daemon double-forked away
// from us — so they survive a restart of the dev-env Node server: killing the
// attach client (which is what shutdown / a crash does) only detaches; the
// session keeps running mid-command with env intact until we explicitly
// kill-session it. On restart we re-attach and the user is back exactly where
// they were, not just scrollback-replayed against a fresh shell.
//
// Everything is scoped to a dedicated socket (`-L garrison`) and a shipped
// config (`-f tmux.garrison.conf`) so we never touch the user's own tmux
// server or their ~/.tmux.conf.

import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

export const TMUX_SOCKET = "garrison";
export const TMUX_CONF = path.resolve(HERE, "tmux.garrison.conf");
const SESSION_PREFIX = "garrison_";

// Foreground commands that mean "a plain shell prompt" — i.e. claude is NOT
// running in this pane. Anything else (claude is a native `claude` binary) is
// treated as a live claude.
const SHELL_COMMANDS = new Set([
  "zsh", "-zsh", "bash", "-bash", "sh", "-sh",
  "fish", "-fish", "dash", "tcsh", "csh", "ksh", "login"
]);

let available = null; // memoized tmux -V probe

function args(extra) {
  return ["-L", TMUX_SOCKET, ...extra];
}

export function tmuxAvailable() {
  if (available !== null) return available;
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore", timeout: 2000 });
    available = true;
  } catch {
    available = false;
  }
  return available;
}

export function tmuxSessionName(ptyId) {
  // Real ptyIds are `<uuid>-<role>` (hyphens only) and pass through untouched.
  // The replace is defensive against dots/colons/whitespace, which tmux would
  // silently corrupt in a session name.
  return SESSION_PREFIX + String(ptyId).replace(/[^A-Za-z0-9_-]/g, "_");
}

export function sessionIdRoleFromName(name) {
  if (typeof name !== "string" || !name.startsWith(SESSION_PREFIX)) return null;
  const ptyId = name.slice(SESSION_PREFIX.length);
  const m = ptyId.match(/^(.+)-(claude|shell)$/);
  if (!m) return null;
  return { sessionId: m[1], role: m[2], ptyId };
}

// argv (without the leading "tmux") to spawn an attach-or-create client as a
// node-pty child. `createCommand` is the shell-command tmux runs ON CREATE
// only — when the session already exists this attaches to the live pane and
// the command is ignored (so re-attaching never relaunches claude).
//   -A  attach if the session exists, else create + attach
//   -D  on attach, detach any other (orphaned) client first — keeps a single
//       live attach client even after an ungraceful server kill
export function attachOrCreateArgs({ name, cwd, cols, rows, createCommand }) {
  return args([
    "-f", TMUX_CONF,
    "new-session", "-A", "-D",
    "-s", name,
    "-x", String(cols),
    "-y", String(rows),
    "-c", cwd,
    createCommand
  ]);
}

export function tmuxHasSession(name) {
  try {
    execFileSync("tmux", args(["has-session", "-t", name]), { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export function tmuxKillSession(name) {
  return new Promise((resolve) => {
    execFile("tmux", args(["kill-session", "-t", name]), { timeout: 3000 }, () => resolve());
  });
}

// Names of every garrison-owned session on our socket (empty when the server
// isn't running). Used for boot-time reconciliation of orphans.
export function listGarrisonSessions() {
  try {
    const out = execFileSync(
      "tmux",
      args(["list-sessions", "-F", "#{session_name}"]),
      { timeout: 3000, encoding: "utf8" }
    );
    return out.split("\n").map((s) => s.trim()).filter((s) => s.startsWith(SESSION_PREFIX));
  } catch {
    return []; // no server / no sessions / tmux gone
  }
}

// The active pane's foreground command (e.g. "claude" or "zsh"), or null if it
// can't be read. Basis for the tmux-mode claude-liveness check.
export function tmuxPaneCommand(name) {
  return new Promise((resolve) => {
    execFile(
      "tmux",
      args(["display-message", "-p", "-t", name, "#{pane_current_command}"]),
      { timeout: 2000 },
      (err, stdout) => resolve(err ? null : (String(stdout).trim() || null))
    );
  });
}

export function isShellCommand(cmd) {
  return !cmd || SHELL_COMMANDS.has(cmd);
}
