// Rich SSE stream + action helpers shared by the gateway and dev-env servers.
//
// The stream is a READ-ONLY observer of the headless-xterm screen: it polls and
// emits structured events (assistant text, status line, mode, turn state, raw
// screen). Sending messages / keys / mode changes are separate POSTs — the
// screen reflects them, so there is no correlation to maintain. This makes the
// same protocol work for the gateway's OperativePtySession and for dev-env's
// shell-PTY claude (with a headless mirror attached).
//
// Event types (SSE `event:` names):
//   hello       { mode, status, busy, assistant, screen }
//   assistant   { text }                 full current reply (client replaces)
//   status      { rows, mode, contextPct, model }
//   turn        { active }               busy<->idle transitions
//   screen      { lines }                full ANSI-stripped viewport (raw view)
//   error       { message }

import {
  captureLines,
  parseStatus,
  isBusy,
  extractLatestAssistant,
} from "./screen.mjs";

function sse(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* client gone */
  }
}

/**
 * Attach a rich SSE observer to an HTTP response, polling `handle`'s screen.
 * Returns a stop() function. `handle` is anything with a `.term` (a PtyHandle
 * or a dev-env mirror).
 */
export function openRichStream(handle, res, opts = {}) {
  const pollMs = opts.pollMs ?? 400;
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();

  let lastAssistant = null;
  let lastStatusKey = null;
  let lastBusy = null;
  let lastScreenKey = null;

  const snapshot = () => {
    const status = parseStatus(handle);
    const busy = isBusy(handle);
    const assistant = extractLatestAssistant(handle);
    const lines = captureLines(handle).filter((l) => l.trim().length > 0);
    return { status, busy, assistant, lines };
  };

  const s0 = snapshot();
  sse(res, "hello", {
    mode: s0.status.mode,
    status: { rows: s0.status.rows, mode: s0.status.mode, contextPct: s0.status.contextPct, model: s0.status.model },
    busy: s0.busy,
    assistant: s0.assistant,
    screen: s0.lines,
  });
  lastAssistant = s0.assistant;
  lastStatusKey = JSON.stringify(s0.status.rows);
  lastBusy = s0.busy;
  lastScreenKey = s0.lines.join("\n");

  const heartbeat = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      /* ignore */
    }
  }, 15_000);

  const timer = setInterval(() => {
    let s;
    try {
      s = snapshot();
    } catch {
      return;
    }
    if (s.busy !== lastBusy) {
      lastBusy = s.busy;
      sse(res, "turn", { active: s.busy });
    }
    if (s.assistant && s.assistant !== lastAssistant) {
      lastAssistant = s.assistant;
      sse(res, "assistant", { text: s.assistant });
    }
    const statusKey = JSON.stringify(s.status.rows);
    if (statusKey !== lastStatusKey) {
      lastStatusKey = statusKey;
      sse(res, "status", {
        rows: s.status.rows,
        mode: s.status.mode,
        contextPct: s.status.contextPct,
        model: s.status.model,
      });
    }
    const screenKey = s.lines.join("\n");
    if (screenKey !== lastScreenKey) {
      lastScreenKey = screenKey;
      sse(res, "screen", { lines: s.lines });
    }
  }, pollMs);

  const stop = () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };
  res.on?.("close", stop);
  return stop;
}

/** A one-shot rich status snapshot for GET /claude/status. */
export function richStatus(handle) {
  const status = parseStatus(handle);
  return {
    mode: status.mode,
    rows: status.rows,
    contextPct: status.contextPct,
    model: status.model,
    busy: isBusy(handle),
  };
}

const KEY_SEQUENCES = {
  escape: "\x1b",
  "shift-tab": "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  tab: "\t",
  "ctrl-c": "\x03",
};

/** Map a named key to its terminal escape sequence (allowlist). */
export function keySequence(name) {
  return KEY_SEQUENCES[name] ?? null;
}

/**
 * Cycle the permission mode toward `target` by sending Shift+Tab and re-reading
 * the mode from the screen. Bounded; returns the achieved mode.
 * @param {object} handle
 * @param {string} target
 * @param {(bytes:string)=>void} write  raw-write fn (handle.writeRaw or pty.write)
 * @returns {Promise<{ok:boolean, mode:string, reached:boolean}>}
 */
export async function cycleMode(handle, target, write) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let current = parseStatus(handle).mode;
  for (let i = 0; i < 5; i++) {
    if (current === target) return { ok: true, mode: current, reached: true };
    write("\x1b[Z"); // Shift+Tab
    await sleep(350);
    current = parseStatus(handle).mode;
  }
  return { ok: current === target, mode: current, reached: current === target };
}
