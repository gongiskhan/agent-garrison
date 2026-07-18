// OperativePtySession — a long-lived interactive Claude Code child, plus the
// `oneShotTurn` helper for one-and-done callers (tier-classifier,
// coding-subagent).
//
// Detection is SCREEN-based, not JSONL-based: the headless xterm mirror is the
// source of truth for the reply, the turn lifecycle, and the live context %
// (see screen.mjs). This is load-bearing, not incidental: claude 2.1.209 sessions
// spawned under node-pty (this PTY/TUI path) do NOT persist a transcript at all —
// verified live, no <session-id>.jsonl is ever written under ~/.claude/projects for
// a PTY session. SDK-driven sessions (the agent-sdk runtime) DO persist transcripts
// with per-assistant-event `usage`; the jsonl.mjs helpers apply to THOSE (and to any
// future claude that journals PTY turns), never to this PTY operative.
//
// Garrison arg shape:
//   - permissionMode "bypassPermissions" -> --dangerously-skip-permissions,
//     anything else -> --permission-mode <mode>
//   - --append-system-prompt-file <path> (interactive TUI has no string
//     system-prompt override; matches what dev-env already does)
//   - fresh spawn pre-mints a UUID -> --session-id <uuid>; resume -> --resume.

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { spawnClaudePty } from "./pty.mjs";
import { isCommandMessage } from "./detection.mjs";
import { claudeProjectDirForCwd } from "./paths.mjs";
import { waitForSessionReady } from "./readiness.mjs";
import { preTrustCwd } from "./trust.mjs";
import {
  turnStarted,
  waitForTurnComplete,
  extractReply,
  parseStatus,
  captureLines,
  hasQueuedMessages,
} from "./screen.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 45 * 1000;

function canonicalisedCwd(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function permissionArgs(permissionMode) {
  if (!permissionMode || permissionMode === "bypassPermissions") {
    return ["--dangerously-skip-permissions"];
  }
  return ["--permission-mode", permissionMode];
}

/**
 * Build the `claude` argv for a Garrison operative/one-shot session.
 * @returns {{argv: string[], sessionUuid: string|null}}
 */
export function buildClaudeArgs({
  permissionMode,
  appendSystemPromptFile,
  model,
  resumeSessionId,
  // Resume the most recent conversation in the cwd. claude 2.1.x persists
  // conversations for `--continue` even though it does not write them to the
  // session JSONL we can read; `--resume <id>` is unreliable for sessions that
  // never got a readable transcript, so the gateway uses --continue.
  continueSession = false,
  sessionUuid: providedSessionUuid,
  // Omit --setting-sources by default so the operative discovers the user's
  // and the project's commands + skills (~/.claude/commands, .claude/commands,
  // skills) — Garrison is a control plane over the real ~/.claude, and Phase 2
  // autocompletes those. Pass a value explicitly to scope settings down.
  settingSources = null,
  extraArgs = [],
}) {
  const argv = [...permissionArgs(permissionMode)];
  let sessionUuid = null;
  if (continueSession) {
    argv.push("--continue");
  } else if (resumeSessionId) {
    argv.push("--resume", resumeSessionId);
  } else {
    sessionUuid = providedSessionUuid ?? randomUUID();
    argv.push("--session-id", sessionUuid);
  }
  if (appendSystemPromptFile) {
    argv.push("--append-system-prompt-file", appendSystemPromptFile);
  }
  if (model) argv.push("--model", model);
  if (settingSources) argv.push("--setting-sources", settingSources);
  argv.push(...extraArgs);
  return { argv, sessionUuid };
}

export class OperativePtySession {
  constructor({ handle, compositionDir, claudeSessionId }) {
    this.handle = handle;
    this.compositionDir = compositionDir;
    this.claudeSessionId = claudeSessionId ?? null;
    this.lastActivityAt = Date.now();
    this.disposed = false;
    this.inflight = null;
    // Session-lifetime peak context percentage (max of every sampled contextPct).
    // Fed by status(), runTurn, and any live sampler (the rich stream) via
    // notePeakContextPct; null until the first numeric sample lands.
    this.peakContextPct = null;
  }

  static async spawn(opts) {
    const claudeBinary = opts.claudeBinary ?? "claude";
    const compositionDir = opts.compositionDir;
    const { argv, sessionUuid } = buildClaudeArgs({
      permissionMode: opts.permissionMode,
      appendSystemPromptFile: opts.appendSystemPromptFile,
      model: opts.model,
      resumeSessionId: opts.resumeSessionId,
      continueSession: opts.continueSession,
      sessionUuid: opts.sessionUuid,
      settingSources: opts.settingSources,
      extraArgs: opts.extraArgs,
    });

    await preTrustCwd(compositionDir);

    const launchEnv = { ...(opts.env ?? process.env) };
    if (launchEnv.GARRISON_CLAUDE_HOME && !launchEnv.CLAUDE_CONFIG_DIR) {
      launchEnv.CLAUDE_CONFIG_DIR = launchEnv.GARRISON_CLAUDE_HOME;
    }
    const handle = spawnClaudePty(claudeBinary, argv, {
      cwd: compositionDir,
      // providerLaunch keeps the explicitly-set ANTHROPIC_BASE_URL/AUTH_TOKEN
      // (e.g. ollama-local / a cloud OSS provider from buildLaunchEnv); the
      // default path strips an INHERITED base URL so the operative rides the Max
      // plan (billing ban).
      env: stripNestingMarkers(launchEnv, { keepProvider: opts.providerLaunch === true }),
      cols: opts.cols,
      rows: opts.rows,
      spawnImpl: opts.spawnImpl,
    });

    // waitForSessionReady stabilises on the input box being live; projectDir/
    // knownFiles are only used for the (now-vestigial) JSONL fast path, so we
    // pass throwaway values — readiness here is purely screen-stabilisation.
    await waitForSessionReady(handle, {
      projectDir: claudeProjectDirForCwd(canonicalisedCwd(compositionDir)),
      knownFiles: new Set(),
      timeoutMs: opts.readinessTimeoutMs ?? 25_000,
      acceptBypassPermissions:
        !opts.permissionMode || opts.permissionMode === "bypassPermissions",
    }).catch((err) => {
      // AuthTrapError or other readiness failure — dispose and rethrow.
      handle.dispose();
      throw err;
    });

    return new OperativePtySession({
      handle,
      compositionDir,
      claudeSessionId: sessionUuid,
    });
  }

  getClaudeSessionId() {
    return this.claudeSessionId;
  }

  isAlive() {
    return !this.disposed && this.handle.isAlive();
  }

  isDisposed() {
    return this.disposed;
  }

  isTurnActive() {
    return this.inflight !== null;
  }

  /** Fold a freshly-sampled context percentage into the session-lifetime peak.
   *  Ignores non-numeric samples (e.g. a missing statusline → contextPct null).
   *  Returns the current peak so a caller can read it back in one call. */
  notePeakContextPct(pct) {
    if (typeof pct === "number" && Number.isFinite(pct)) {
      this.peakContextPct = this.peakContextPct === null ? pct : Math.max(this.peakContextPct, pct);
    }
    return this.peakContextPct;
  }

  /** The session-lifetime peak context percentage (null before any sample). */
  getPeakContextPct() {
    return this.peakContextPct;
  }

  /** Current parsed status line (model, context %, permission mode, rows) plus
   *  the session-lifetime peakContextPct. Sampling here also updates the peak. */
  status() {
    const status = parseStatus(this.handle);
    this.notePeakContextPct(status.contextPct);
    return { ...status, peakContextPct: this.peakContextPct };
  }

  /** Send one prompt and wait for the turn to finish. One turn at a time. */
  async runTurn(req) {
    if (this.disposed) throw new Error("OperativePtySession is disposed; cannot run a new turn.");
    if (this.inflight !== null) throw new Error("OperativePtySession already has an inflight turn.");
    const commandMode = isCommandMessage(req.message);
    const turnPromise = this.#runInner(req, commandMode);
    this.inflight = turnPromise;
    try {
      const outcome = await turnPromise;
      this.lastActivityAt = Date.now();
      return outcome;
    } finally {
      this.inflight = null;
    }
  }

  async #runInner(req, commandMode) {
    const startTs = Date.now();
    const timeout = req.timeoutMs ?? (commandMode ? COMMAND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    // A real prompt (not a bare slash command) must be observed working before the
    // turn can settle — see waitForTurnComplete's `requireWork`. This is what stops
    // a Discuss turn from "completing" in ~3s off a stale idle screen with an empty
    // reply.
    const requireWork = !commandMode;

    const registered = await this.#submitAndConfirm(req.message, req.settleMs);
    if (!registered) {
      if (!this.handle.isAlive()) {
        throw new Error(
          `OperativePtySession: claude process exited (code ${this.handle.exitCode?.() ?? "unknown"}); cannot run a turn.`
        );
      }
      throw new Error("OperativePtySession: message never registered (claude did not accept input).");
    }

    const completion = await waitForTurnComplete(this.handle, {
      startTs,
      timeoutMs: timeout,
      onUpdate: req.onScreen,
      requireWork,
    });
    if (completion.signal === "timeout") {
      throw new Error(`OperativePtySession turn timed out after ${completion.elapsedMs}ms.`);
    }

    let reply = extractReply(this.handle, req.message);
    // The reply can still be mid-render at the exact instant the turn idled. For a
    // real prompt an empty scrape is almost always that race (not a genuinely empty
    // turn), so give the screen one more short settle and re-scrape before giving
    // up — cheap insurance against an empty Discuss reply.
    if (!reply && requireWork) {
      await sleep(900);
      reply = extractReply(this.handle, req.message);
    }
    const status = parseStatus(this.handle);
    this.notePeakContextPct(status.contextPct);
    return {
      reply,
      sessionId: this.claudeSessionId,
      completion,
      status: { ...status, peakContextPct: this.peakContextPct },
    };
  }

  /**
   * Submit the message, then confirm the turn actually started. A fresh TUI
   * discards stdin for the first few seconds of startup, so an early send is
   * lost entirely. We retry clear+resend until turnStarted() is true (an
   * assistant marker / busy spinner / completion marker appears). Each retry
   * first sends Ctrl-U (\x15), which reliably clears the claude input box, so
   * retries never accumulate "messagemessage". Verified against the live TUI.
   * @returns {Promise<boolean>}
   */
  async #submitAndConfirm(message, settleMs) {
    const deadline = Date.now() + 30_000;
    let first = true;
    while (Date.now() < deadline && !this.disposed) {
      // A dead child never accepts input — bail immediately instead of
      // clear+resend-looping against a frozen screen for the full deadline.
      if (!this.handle.isAlive()) return false;
      if (!first) this.handle.writeRaw("\x15"); // Ctrl-U clear before resend
      first = false;
      await this.handle.sendInput(message, settleMs);
      if (await this.#waitTurnStarted(4000)) return true;
      // Submission accepted but QUEUED (the TUI was still busy with something).
      // The queued message runs when the TUI frees — it IS registered, and a
      // resend would stack a duplicate turn on the queue.
      if (hasQueuedMessages(this.handle)) return true;
    }
    return false;
  }

  async #waitTurnStarted(windowMs) {
    const end = Date.now() + windowMs;
    while (Date.now() < end && !this.disposed) {
      if (turnStarted(this.handle)) return true;
      await sleep(250);
    }
    return false;
  }

  /** Send raw bytes (escape sequences / control keys) into the PTY. */
  writeKeys(bytes) {
    if (this.disposed) return;
    this.handle.writeRaw(bytes);
  }

  /** Snapshot the current screen as ANSI-stripped lines. */
  screen() {
    return captureLines(this.handle);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.handle.dispose();
  }
}

function stripNestingMarkers(env, { keepProvider = false } = {}) {
  const out = { ...env };
  delete out.CLAUDECODE;
  // Never ride an inherited raw API key (would bill the API instead of the plan).
  delete out.ANTHROPIC_API_KEY;
  // Default: scrub an inherited base URL so the operative uses the Max plan. A
  // provider launch (keepProvider) sets ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
  // deliberately (buildLaunchEnv) — keep them so the launch actually reaches the
  // local/cloud-OSS provider. (ANTHROPIC_AUTH_TOKEN is never stripped — matches
  // the original default; it is only ever set intentionally.)
  if (!keepProvider) delete out.ANTHROPIC_BASE_URL;
  return out;
}

/**
 * One-shot: spawn -> readiness -> one turn -> dispose. For callers that want a
 * single answer and don't keep a session (tier-classifier, coding-subagent).
 * @returns {Promise<{reply: string, sessionId: string|null}>}
 */
export async function oneShotTurn(opts) {
  const session = await OperativePtySession.spawn({
    compositionDir: opts.cwd,
    appendSystemPromptFile: opts.appendSystemPromptFile,
    model: opts.model,
    permissionMode: opts.permissionMode ?? "bypassPermissions",
    claudeBinary: opts.claudeBinary,
    env: opts.env,
    cols: opts.cols,
    rows: opts.rows,
    readinessTimeoutMs: opts.readinessTimeoutMs,
    spawnImpl: opts.spawnImpl,
    extraArgs: opts.extraArgs,
  });
  // Optional peek at the disposable session (e.g. to build a streaming reply
  // extractor over its handle). The session is disposed below regardless.
  if (typeof opts.onSession === "function") {
    try {
      opts.onSession(session);
    } catch {
      /* observer errors never break the turn */
    }
  }
  try {
    const outcome = await session.runTurn({
      message: opts.message,
      timeoutMs: opts.timeoutMs,
      onScreen: opts.onScreen,
    });
    return { reply: outcome.reply, sessionId: outcome.sessionId };
  } finally {
    session.dispose();
  }
}
