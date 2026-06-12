// Screen reading for the interactive Claude Code TUI.
//
// Claude 2.1.175 fires hooks reliably but does NOT persist conversation
// content to the session JSONL (only an `ai-title` line) — verified
// empirically. The headless xterm screen is therefore the source of truth for
// the reply, status line, mode, and turn lifecycle. This is exactly the
// "node-pty + headless xterm" technique: read structured state off the mirror.
//
// TUI anatomy (claude 2.1.x), top-to-bottom:
//   - welcome box / prior transcript
//   - user message echoes:      "❯ <message>"
//   - assistant blocks:         "⏺ <first line>" then 2-space-indented lines
//   - tool actions:             "⏺ <Tool>(...)" with indented result lines
//   - completion indicator:     "✻ Baked for 3s" (Baked|Cooked|Brewed|…)
//   - while busy:               a spinner line containing "(esc to interrupt)"
//   - input box:                "❯ " (empty when ready) between two rule lines
//   - status line:              "<name> | <ctx>% | <model>  …limit…"
//   - mode line:                "⏵⏵ bypass permissions on (shift+tab to cycle)"

import { stripAnsi } from "./detection.mjs";

/** Full current viewport as ANSI-stripped lines (claude uses the alt screen,
 *  so this is the whole visible TUI; there is no scrollback to recover). */
export function captureLines(handle) {
  const buf = handle.term.buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    out.push(line ? stripAnsi(line.translateToString(true)) : "");
  }
  return out;
}

const ASSISTANT_MARKER = /^\s*[⏺●]\s?/;
const BUSY_MARKER = /\(esc to interrupt\)|esc to interrupt/i;
const RULE_LINE = /^[─━—_]{10,}\s*$/;
const STATUS_LINE = /\|\s*\d+%\s*\|/; // "<name> | 14% | Sonnet 4.6@high"
const MODE_LINE = /(bypass permissions|accept edits|plan mode|normal mode|permissions? on|shift\+?tab to cycle)/i;
// The completion/progress indicator is "<glyph> <Word> for <N>s" where <Word>
// is one of dozens of whimsical claude spinner verbs — don't enumerate them;
// match the stable "for <N>s" timing suffix (optionally with a leading spinner
// glyph). Used as a hard stop when scraping the assistant reply.
const SPINNER_DONE = /\bfor \d+(?:\.\d+)?s\b\s*$/i;
const SPINNER_GLYPH = /^\s*[✻✶✷✵✳✲✴✦✧❋❉∗*·•]\s/;
// In-progress indicator lines: "✻ Embellishing (running stop hooks 3/4 · 2s ·
// 8 tokens)" etc. Match the parenthetical progress content so these never leak
// into the scraped reply even when the leading glyph varies.
const PROGRESS_LINE = /\(\s*(running |esc to interrupt|\d+\/\d+|\d+s\b|[\d,]+ tokens?)/i;

/** True while a turn is processing (spinner with interrupt hint visible). */
export function isBusy(handle) {
  return captureLines(handle).some((l) => BUSY_MARKER.test(l));
}

/** The bottom input box is ready for input: an "❯" prompt line that is empty
 *  (no pending typed text) sitting between/after the rule lines, with no busy
 *  spinner anywhere. */
export function isPromptReady(handle) {
  const lines = captureLines(handle);
  if (lines.some((l) => BUSY_MARKER.test(l))) return false;
  // Find the last "❯" line; ready when its content is empty.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*❯\s?(.*)$/.exec(lines[i]);
    if (m) return m[1].trim().length === 0;
  }
  return false;
}

/** Extract the rich status line + mode + context% from the bottom rows. */
export function parseStatus(handle) {
  const lines = captureLines(handle);
  let statusRow = null;
  let modeRow = null;
  // Scan all rows (the alt-screen buffer has trailing empties below the status
  // line) and keep the LAST match of each.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (STATUS_LINE.test(l)) statusRow = l.trim();
    if (MODE_LINE.test(l)) modeRow = l.trim();
  }
  let contextPct = null;
  let model = null;
  if (statusRow) {
    // The status line has a left segment and a right segment separated by a
    // run of spaces: "name | 14% | Sonnet 4.6@high      You've used 93%...".
    // Parse model/context from the left segment only.
    const left = statusRow.split(/\s{2,}/)[0];
    const pct = /(\d+)%/.exec(left);
    if (pct) contextPct = Number(pct[1]);
    const segs = left.split("|").map((s) => s.trim()).filter(Boolean);
    if (segs.length) model = segs[segs.length - 1];
  }
  return {
    statusRow,
    modeRow,
    mode: parsePermissionMode(modeRow ?? ""),
    contextPct,
    model,
    // The non-empty bottom rows verbatim, for a "real status line" strip in the
    // UI. Take the last few non-empty lines (status + mode + any hints).
    rows: lines.filter((l) => l.trim().length > 0).slice(-4),
  };
}

/** Map a mode/status row to a canonical permission mode. */
export function parsePermissionMode(row) {
  const s = row.toLowerCase();
  if (/plan mode/.test(s)) return "plan";
  if (/accept edits/.test(s)) return "acceptEdits";
  if (/bypass permissions/.test(s)) return "bypassPermissions";
  if (/normal mode|permissions ask|ask permissions/.test(s)) return "default";
  return "unknown";
}

/**
 * Extract the latest assistant reply text from the screen.
 *
 * Strategy: find the last line that echoes the user's submitted message
 * ("❯ <userMessage>"), then collect the assistant block(s) below it — lines
 * starting at the "⏺" marker plus their 2-space-indented continuations —
 * stopping at the completion indicator, a rule line, the input box, or the
 * status line. Tool-action blocks ("⏺ Tool(...)") are skipped so the returned
 * text is the assistant's prose.
 */
export function extractReply(handle, userMessage) {
  const lines = captureLines(handle);
  const needle = (userMessage ?? "").trim().slice(0, 40);

  // Locate the user echo line (last occurrence).
  let startIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^\s*❯\s/.test(l) && needle && l.includes(needle.slice(0, 24))) {
      startIdx = i;
      break;
    }
  }
  // Fallback: last assistant marker block.
  if (startIdx === -1) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (ASSISTANT_MARKER.test(lines[i])) {
        startIdx = i - 1;
        break;
      }
    }
  }
  if (startIdx === -1) return "";

  const collected = [];
  let inAssistant = false;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const l = raw.replace(/\s+$/, "");
    if (l.trim() === "") {
      if (inAssistant) collected.push("");
      continue;
    }
    if (RULE_LINE.test(l) || SPINNER_DONE.test(l) || BUSY_MARKER.test(l) || SPINNER_GLYPH.test(l) || PROGRESS_LINE.test(l)) break;
    if (STATUS_LINE.test(l) || MODE_LINE.test(l)) break;
    if (/^\s*❯/.test(l)) break; // reached the input box / next user echo
    const markerMatch = ASSISTANT_MARKER.exec(l);
    if (markerMatch) {
      const rest = l.slice(markerMatch[0].length);
      // Skip tool-action blocks like "⏺ Bash(...)" / "Update(file)" — these are
      // actions, not prose. Heuristic: a tool action's first token is
      // CapitalizedWord immediately followed by "(".
      if (/^[A-Z][A-Za-z]+\(/.test(rest.trim())) {
        inAssistant = false;
        continue;
      }
      inAssistant = true;
      collected.push(rest.trim());
      continue;
    }
    if (inAssistant) {
      // Continuation lines are indented by 2 spaces under the marker.
      collected.push(l.replace(/^ {1,3}/, ""));
    }
  }
  return collected.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Extract the most recent assistant block on screen, without needing to know
 *  the user's message (for the read-only rich-stream observer). Finds the last
 *  assistant marker and collects its block. */
export function extractLatestAssistant(handle) {
  const lines = captureLines(handle);
  let markerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (ASSISTANT_MARKER.test(l)) {
      const rest = l.replace(ASSISTANT_MARKER, "");
      if (!/^[A-Z][A-Za-z]+\(/.test(rest.trim())) {
        markerIdx = i;
        break;
      }
    }
  }
  if (markerIdx === -1) return "";
  const collected = [];
  for (let i = markerIdx; i < lines.length; i++) {
    const l = lines[i].replace(/\s+$/, "");
    if (i > markerIdx) {
      if (l.trim() === "") {
        collected.push("");
        continue;
      }
      if (
        RULE_LINE.test(l) ||
        SPINNER_DONE.test(l) ||
        BUSY_MARKER.test(l) ||
        SPINNER_GLYPH.test(l) ||
        PROGRESS_LINE.test(l) ||
        STATUS_LINE.test(l) ||
        MODE_LINE.test(l) ||
        /^\s*❯/.test(l) ||
        ASSISTANT_MARKER.test(l)
      ) {
        break;
      }
      collected.push(l.replace(/^ {1,3}/, ""));
    } else {
      collected.push(l.replace(ASSISTANT_MARKER, "").trim());
    }
  }
  return collected.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** True when a turn appears to have started: an assistant marker, the busy
 *  spinner, or a completion indicator is present below the input — i.e. claude
 *  accepted the submission and is processing/finished (not still swallowing
 *  input during startup). */
export function turnStarted(handle) {
  const lines = captureLines(handle);
  return lines.some((l) => BUSY_MARKER.test(l) || SPINNER_DONE.test(l) || ASSISTANT_MARKER.test(l));
}

/**
 * Wait for a turn to complete, reading the screen only.
 *
 * Lifecycle: the submit-confirm loop has already gotten the turn to start
 * (turnStarted() true). We then wait for the busy spinner to clear and the
 * input prompt to come back, stable for a short dwell. For command-only turns
 * (slash commands that just print) there may be no assistant marker — prompt-
 * ready + stable is enough.
 *
 * @param {object} handle
 * @param {{startTs:number, timeoutMs:number, onUpdate?:Function, settleMs?:number}} opts
 * @returns {Promise<{signal:'done'|'timeout', elapsedMs:number}>}
 */
export async function waitForTurnComplete(handle, opts) {
  const { startTs, timeoutMs } = opts;
  const settleNeeded = opts.settleMs ?? 1400;
  const pollMs = 350;
  let readySince = null;
  let lastSnapshot = "";
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const elapsed = Date.now() - startTs;
      if (elapsed > timeoutMs) {
        clearInterval(timer);
        resolve({ signal: "timeout", elapsedMs: elapsed });
        return;
      }
      const lines = captureLines(handle);
      if (opts.onUpdate) {
        try {
          opts.onUpdate(lines);
        } catch {
          /* streaming consumer error must not kill detection */
        }
      }
      const busy = lines.some((l) => BUSY_MARKER.test(l));
      const promptReady = (() => {
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = /^\s*❯\s?(.*)$/.exec(lines[i]);
          if (m) return m[1].trim().length === 0;
        }
        return false;
      })();
      const snapshot = lines.join("\n");
      const stable = snapshot === lastSnapshot;
      lastSnapshot = snapshot;

      if (!busy && promptReady && stable) {
        if (readySince === null) readySince = Date.now();
        if (Date.now() - readySince >= settleNeeded) {
          clearInterval(timer);
          resolve({ signal: "done", elapsedMs: elapsed });
        }
      } else {
        readySince = null;
      }
    }, pollMs);
  });
}

export { SPINNER_DONE, BUSY_MARKER, ASSISTANT_MARKER };
