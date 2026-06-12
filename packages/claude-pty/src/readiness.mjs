// Session readiness probe. The interactive Claude Code TUI discards stdin for
// the first several seconds of startup (raw-mode transition + banner render),
// so a prompt char appearing on screen early is NOT a reliable "ready for
// input" signal — sending then loses the text entirely. We instead wait for
// the screen to STABILISE: during startup the TUI repaints rapidly; once the
// input box is live the bottom rows stop changing. Ready = a prompt is visible
// AND the screen has been unchanged for a short dwell AND a floor of elapsed
// time has passed.
//
// Garrison addition over the ekoa donor: an auth-trap fast-fail — if the TUI
// is sitting on a login / theme / trust screen, reject immediately rather than
// letting the first turn hang for the full turn timeout.

import { getLastRows } from "./pty.mjs";
import { findNewestJsonl, stripAnsi, detectPromptReady } from "./detection.mjs";

const AUTH_TRAP_PATTERNS = [
  /select login method/i,
  /sign in to claude/i,
  /choose .*(text style|theme)/i,
  /browser did ?n.?t open/i,
  /press enter to (login|continue|retry)/i,
  /invalid api key|authentication failed|please run .*login/i,
];

// The TUI must be quiet for at least this long with a prompt visible before we
// call it ready. Startup repaints are faster than this.
const STABLE_DWELL_MS = 1200;
// Never declare ready before this — even a coincidentally-stable early frame
// is not trusted.
const MIN_ELAPSED_MS = 3500;

export class AuthTrapError extends Error {
  constructor(excerpt) {
    super(`Claude TUI appears to be waiting on a login/setup screen, not ready for input:\n${excerpt}`);
    this.name = "AuthTrapError";
    this.excerpt = excerpt;
  }
}

/**
 * Wait until the spawned session is ready for its first prompt. Resolves with
 * the JSONL transcript path if it was discovered (else null — the caller falls
 * back to dynamic discovery + the submit-confirm loop). Rejects with
 * AuthTrapError if a login screen shows.
 *
 * @param {object} handle
 * @param {{projectDir: string, knownFiles: Set<string>, timeoutMs?: number, pollMs?: number}} opts
 * @returns {Promise<string|null>}
 */
export async function waitForSessionReady(handle, opts) {
  const timeout = opts.timeoutMs ?? 25_000;
  const interval = opts.pollMs ?? 250;
  const start = Date.now();
  let lastScreen = "";
  let stableSince = null;

  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      const rows = getLastRows(handle, 12);
      const clean = stripAnsi(rows);
      const elapsed = Date.now() - start;

      if (AUTH_TRAP_PATTERNS.some((p) => p.test(clean))) {
        clearInterval(check);
        reject(new AuthTrapError(clean.slice(-300)));
        return;
      }

      if (elapsed > timeout) {
        clearInterval(check);
        resolve(findNewestJsonl(opts.projectDir, opts.knownFiles));
        return;
      }

      // Track screen stability.
      if (clean === lastScreen) {
        if (stableSince === null) stableSince = Date.now();
      } else {
        stableSince = null;
        lastScreen = clean;
      }

      const promptVisible = detectPromptReady(rows) && clean.trim().length > 20;
      const stableLongEnough = stableSince !== null && Date.now() - stableSince >= STABLE_DWELL_MS;

      if (promptVisible && stableLongEnough && elapsed >= MIN_ELAPSED_MS) {
        clearInterval(check);
        const newFile = findNewestJsonl(opts.projectDir, opts.knownFiles);
        if (newFile !== null) opts.knownFiles.add(newFile);
        resolve(newFile);
        return;
      }
    }, interval);
  });
}
