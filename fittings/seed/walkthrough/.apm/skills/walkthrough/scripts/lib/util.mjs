// Shared helpers for the walkthrough recording pipeline.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Run a command, capturing stdout/stderr. Never inherits the user's TTY.
// Resolves with { code, stdout, stderr } and never rejects on non-zero exit
// (callers decide what a non-zero code means).
export function exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = opts.timeoutMs
      ? setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, opts.timeoutMs)
      : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
  });
}

// Per-run playwright-cli isolation so concurrent walkthrough runs (different
// sessions/projects recording at once) NEVER tear each other down.
//
// playwright-cli keys its session registry by a *workspace* hash it derives by
// walking up from cwd for a `.playwright` dir. Our runs live under
// ~/.walkthrough/runs/... where there is none, so EVERY run on this machine
// collapses to the same fallback hash and the same `default` session. Two
// cross-run collisions follow:
//   • `open` for `default` first STOPS the existing `default` daemon — so run
//     B's open kills run A's live browser.
//   • `close-all` is WORKSPACE-scoped, not session-scoped: it stops every
//     session under that shared hash — so run B's between-segment teardown
//     kills run A's browser too. (A named session via `-s=` does NOT help:
//     close-all still enumerates the whole workspace.)
// The fix isolates BOTH levers per run: a private daemon dir
// (PLAYWRIGHT_DAEMON_SESSION_DIR — scopes the registry, hence close-all, and
// the session/profile files) AND a unique session name (scopes the daemon
// socket, which is keyed by <workspaceHash>-<session>). Either alone is
// insufficient; together they make every cross-run path impossible.
//
// Both are derived deterministically from workDir (unique + stable per run), so
// the many separate `playwright-cli` processes of ONE run all target the same
// daemon while different runs never alias. `lane` puts the throwaway screenshot
// browser (title cards / caption bars) on its own session so a render can never
// disturb a kept-open recording session. Override the dir with
// WALKTHROUGH_PW_DAEMON_DIR only if you must force a specific namespace.
function runScope(workDir, lane) {
  const id = crypto.createHash('sha1').update(path.resolve(workDir || process.cwd())).digest('hex').slice(0, 8);
  const daemonDir = process.env.WALKTHROUGH_PW_DAEMON_DIR || path.join(os.tmpdir(), 'wt-pw', id);
  const session = `${lane === 'render' ? 'wtr' : 'wt'}${id}`; // short: socket path is length-bounded on macOS
  return { daemonDir, session };
}

// Run playwright-cli pinned to the run's work dir (its file sandbox) and the
// run's private daemon namespace (see runScope). opts.lane selects the recording
// browser (default) or the render/screenshot browser.
export async function pw(args, workDir, opts = {}) {
  const { daemonDir, session } = runScope(workDir, opts.lane);
  mkdirSync(daemonDir, { recursive: true });
  const r = await exec('playwright-cli', [`-s=${session}`, ...args], {
    cwd: workDir,
    timeoutMs: opts.timeoutMs || 120000,
    env: { PLAYWRIGHT_DAEMON_SESSION_DIR: daemonDir },
  });
  return r;
}

// Parse the `### Result\n"..."` block that playwright-cli prints for run-code.
// The result is a JSON string (we always `return JSON.stringify(x)`), so it is
// double-encoded: the block holds a quoted JSON string we must JSON.parse twice.
export function parseRunCodeResult(stdout) {
  const idx = stdout.indexOf('### Result');
  if (idx === -1) return null;
  const after = stdout.slice(idx + '### Result'.length);
  // The value is on the following line(s) up to the next `### ` header.
  const stop = after.indexOf('\n### ');
  const raw = (stop === -1 ? after : after.slice(0, stop)).trim();
  if (!raw) return null;
  try {
    const once = JSON.parse(raw);          // -> the inner JSON string
    return typeof once === 'string' ? JSON.parse(once) : once;
  } catch {
    return null;
  }
}

// Probe a media file's duration in seconds (float). Returns 0 on failure.
export async function ffprobeDuration(file) {
  const r = await exec('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nk=1:nw=1', file,
  ]);
  const v = parseFloat(r.stdout.trim());
  return Number.isFinite(v) ? v : 0;
}

// Build a data: URL from an HTML string (used for title cards / caption bars,
// since playwright-cli blocks file:// and screenshots are sandboxed to cwd).
export function htmlDataUrl(html) {
  return 'data:text/html,' + encodeURIComponent(html);
}

// First existing path from a list (e.g. picking a system font), else null.
export function firstExisting(paths) {
  return paths.find((p) => existsSync(p)) || null;
}

export function fmtTimestamp(d) {
  // YYYY-MM-DD_HH-MM-SS in local time. Caller passes the Date (kept out of lib
  // so the pipeline stays deterministic/testable).
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
