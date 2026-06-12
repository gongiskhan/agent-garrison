// PTY spawn + headless-xterm mirror. Ported from ekoa-core/src/sandbox/pty.ts
// with the bubblewrap L2 sandbox dropped — Garrison is macOS-local,
// single-user, no sandbox (project CLAUDE.md: bypassPermissions, talks only
// to localhost). The interactive Claude Code TUI is full-screen, so we
// allocate a real PTY (xterm-256color, 200x50) and pipe its output into an
// @xterm/headless terminal. Callers ask the terminal structured questions
// (cursor position, last N rows) instead of byte-diffing stdout.

import { realpathSync } from "node:fs";
import nodePty from "node-pty";
import xtermHeadless from "@xterm/headless";

// @xterm/headless v6 ships as CJS with a default export; a named import
// fails under Node ESM. Pull Terminal off the default export at runtime.
const Terminal = xtermHeadless.Terminal;

const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;

/**
 * Spawn `command argv` attached to a fresh PTY, mirrored into a headless
 * xterm terminal.
 *
 * @param {string} command
 * @param {readonly string[]} argv
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, cols?: number, rows?: number, spawnImpl?: Function}} opts
 * @returns {PtyHandle}
 */
export function spawnClaudePty(command, argv, opts = {}) {
  const cols = opts.cols ?? DEFAULT_COLS;
  const rows = opts.rows ?? DEFAULT_ROWS;
  // Canonicalise the cwd. macOS /tmp -> /private/tmp; claude stores session
  // JSONLs under the canonical path. Without this, detection reads from
  // /var/... while claude writes to /private/var/... and never sees the
  // transcript.
  const rawCwd = opts.cwd ?? process.cwd();
  let cwd;
  try {
    cwd = realpathSync(rawCwd);
  } catch {
    cwd = rawCwd;
  }
  const spawnImpl = opts.spawnImpl ?? nodePty.spawn;

  const term = new Terminal({ cols, rows, allowProposedApi: true });

  // node-pty's posix_spawnp requires a strict { [k]: string } env — undefined
  // values trip the spawn. Filter them out.
  const cleanEnv = {};
  for (const [k, v] of Object.entries(opts.env ?? process.env)) {
    if (typeof v === "string") cleanEnv[k] = v;
  }

  const pty = spawnImpl(command, [...argv], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: cleanEnv,
  });

  pty.onData((data) => {
    try {
      term.write(data);
    } catch {
      /* terminal may be mid-teardown */
    }
  });

  let disposed = false;
  return {
    pty,
    term,
    cwd,
    cols,
    rows,
    onData(handler) {
      return pty.onData(handler);
    },
    onExit(handler) {
      return pty.onExit(handler);
    },
    resize(nextCols, nextRows) {
      try {
        pty.resize(nextCols, nextRows);
      } catch {
        /* ignore */
      }
      try {
        term.resize(nextCols, nextRows);
      } catch {
        /* ignore */
      }
    },
    /** Two-phase submit: write text, settle, then send `\r`. The TUI
     *  sometimes treats `text + '\r'` in one write as a paste and absorbs
     *  the trailing newline, so Enter is a separate write after a settle.
     *  Default 600ms — dev-env's ptys.mjs found 300ms loses the Enter
     *  against a live claude TUI on macOS; 600ms is its proven value. */
    async sendInput(text, settleMs = 600) {
      pty.write(text);
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      pty.write("\r");
    },
    /** Write raw bytes (escape sequences, control keys) with no Enter. */
    writeRaw(bytes) {
      pty.write(bytes);
    },
    isAlive() {
      return !disposed && pty.pid !== undefined;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        pty.kill();
      } catch {
        /* already dead */
      }
    },
  };
}

/** Cursor position from a handle's headless terminal. */
export function getCursorPosition(handle) {
  return { x: handle.term.buffer.active.cursorX, y: handle.term.buffer.active.cursorY };
}

/** Last N rows from the terminal (ending at the cursor row), joined with
 *  newlines. Used by the prompt/mode matchers to assess screen state without
 *  scanning the full buffer. */
export function getLastRows(handle, n = 5) {
  const buf = handle.term.buffer.active;
  const end = Math.min(buf.cursorY + 1, buf.length);
  const start = Math.max(0, end - n);
  const lines = [];
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}

/** All non-blank rows currently on screen (full viewport), ANSI already
 *  resolved by the terminal. Used for screen-diff command completion. */
export function getScreenRows(handle, maxRows = 50) {
  const buf = handle.term.buffer.active;
  const end = Math.min(buf.length, buf.cursorY + 1);
  const start = Math.max(0, end - maxRows);
  const lines = [];
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines;
}
