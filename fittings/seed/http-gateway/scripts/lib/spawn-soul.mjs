// Spawn a Claude Code PTY session for a Soul (or the Orchestrator).
// Two modes:
//   - "headless": drive the interactive Claude Code TUI through
//                 @garrison/claude-pty. Synthetic assistant events republish
//                 to the channel hub after each turn.
//   - "interactive": delegate to Garrison Next.js's /api/interactive/spawn-soul-tab
//                  which opens a PTY in the Interactive panel. We then install
//                  a JSONL watcher to extract summary feedback.

import path from "node:path";
import fsp from "node:fs/promises";
import { OperativePtySession } from "@garrison/claude-pty";
import { logEvent } from "./log.mjs";

const COMMON_FLAGS = ["--permission-mode", "bypassPermissions"];

const GARRISON_TOOLS_DISALLOWED_FOR_SOULS = [
  "mcp__garrison__talk_to",
  "mcp__garrison__wait_for",
  "mcp__garrison__list_active_sessions",
  "mcp__garrison__end_session",
  "mcp__garrison__list_workdirs"
];

export function disallowedToolsForSoul(spawnConfig) {
  const declared = spawnConfig?.disallowed_tools ?? [];
  return Array.from(new Set([...declared, ...GARRISON_TOOLS_DISALLOWED_FOR_SOULS]));
}

export function disallowedToolsForOrchestrator(spawnConfig) {
  return spawnConfig?.disallowed_tools ?? [];
}

/**
 * Build the interactive claude CLI argument list for a given soul SpawnConfig
 * + tier flags. Used only by interactive-tab delegations.
 */
export function buildClaudeArgs({
  sessionUuid,
  spawnConfig,
  resume,
  tierFlags = [],
  mcpConfigPath,
  isOrchestrator,
  promptPath
}) {
  const args = [...COMMON_FLAGS];
  if (resume) {
    args.push("--resume", sessionUuid);
  } else {
    args.push("--session-id", sessionUuid);
  }
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  }
  if (spawnConfig?.preset === "claude_code") {
    if (promptPath) args.push("--append-system-prompt-file", promptPath);
    if (spawnConfig?.exclude_dynamic_sections) {
      args.push("--exclude-dynamic-system-prompt-sections");
    }
  } else if (promptPath) {
    args.push("--append-system-prompt-file", promptPath);
  }
  if (spawnConfig?.allowed_tools && spawnConfig.allowed_tools.length > 0) {
    args.push("--allowedTools", spawnConfig.allowed_tools.join(","));
  }
  const disallowed = isOrchestrator
    ? disallowedToolsForOrchestrator(spawnConfig)
    : disallowedToolsForSoul(spawnConfig);
  if (disallowed.length > 0) {
    args.push("--disallowedTools", disallowed.join(","));
  }
  args.push(...tierFlags);
  return args;
}

export function spawnHeadless({
  sessionUuid,
  spawnConfig,
  promptPath,
  cwd,
  tierFlags,
  mcpConfigPath,
  isOrchestrator,
  resume,
  onEvent,
  onResult,
  onExit
}) {
  return new PtySoulAdapter({
    sessionUuid,
    spawnConfig,
    promptPath,
    cwd,
    tierFlags,
    mcpConfigPath,
    isOrchestrator,
    resume,
    onEvent,
    onResult,
    onExit
  });
}

// A `--resume <id>` whose conversation doesn't exist on this machine either
// exits immediately ("No conversation found with session ID: …", caught by the
// StartupExitError path) or, on some claude versions, sits wedged on the banner
// with a live prompt — the same class of wedge gateway-pty.mjs handles for
// `--continue`.
const RESUME_WEDGE_RE = /no conversation found/i;

class PtySoulAdapter {
  constructor(opts) {
    this.opts = opts;
    this.session = null;
    this.exitCode = null;
    this.killed = false;
    this.dead = false;
    this.queue = Promise.resolve();
    this.ready = this.#start();
    // A failed spawn must surface as an exit, not as an unhandled rejection —
    // the gateway drops its handle on onExit and reboots on the next turn.
    this.ready.catch((err) => {
      this.dead = true;
      this.exitCode = 1;
      logEvent("stderr", { kind: "soul-spawn-failed", session: this.opts.sessionUuid, error: err.message });
      try { this.opts.onExit?.(1, "spawn-failed"); } catch { /* ignore */ }
    });
  }

  async #start() {
    const {
      sessionUuid,
      spawnConfig,
      promptPath,
      cwd,
      tierFlags,
      mcpConfigPath,
      isOrchestrator,
      resume
    } = this.opts;
    if (cwd === undefined) {
      logEvent("stderr", { kind: "spawn-soul-warn", message: "no cwd provided", session: sessionUuid });
    }
    const extraArgs = buildExtraArgs({ spawnConfig, tierFlags, mcpConfigPath, isOrchestrator });
    const spawnOnce = (asResume) =>
      OperativePtySession.spawn({
        compositionDir: cwd ?? process.cwd(),
        appendSystemPromptFile: promptPath,
        sessionUuid: asResume ? undefined : sessionUuid,
        resumeSessionId: asResume ? sessionUuid : undefined,
        permissionMode: "bypassPermissions",
        extraArgs,
        // 200x50 (the claude-pty default), NOT 140x42: a long multi-line turn
        // (a Kanban phase prompt) wraps past a 42-row viewport, the TUI's
        // input editor overflows the screen, and Enter never submits — the
        // exact "message never registered" wedge. Verified empirically:
        // the same prompt registers at 200x50 and wedges at 140x42.
        cols: 200,
        rows: 50
      });
    if (resume) {
      try {
        this.session = await spawnOnce(true);
        // Wedge with a live prompt: banner rendered, TUI waiting. Respawn fresh.
        if (this.session.screen().some((line) => RESUME_WEDGE_RE.test(line))) {
          logEvent("stderr", { kind: "soul-resume-wedge", session: sessionUuid, message: "resume banner on live screen — respawning fresh" });
          try { this.session.dispose(); } catch { /* best effort */ }
          this.session = await spawnOnce(false);
        }
      } catch (err) {
        if (err?.name === "AuthTrapError") throw err; // a fresh spawn would trap the same way
        // Instant-exit wedge (or any other resume startup failure): the recorded
        // session isn't resumable here. Fall back to a FRESH session under the
        // same uuid — it was never used, so --session-id accepts it and the
        // gateway's persisted marker stays valid.
        logEvent("stderr", { kind: "soul-resume-wedge", session: sessionUuid, error: err.message });
        this.session = await spawnOnce(false);
      }
    } else {
      this.session = await spawnOnce(false);
    }
    this.#watchExit(this.session);
    logEvent("stdout", { kind: "soul-ready", session: sessionUuid, claude_session: this.session.getClaudeSessionId() });
  }

  // The claude child exiting out from under us (crash, /exit, OOM) must mark
  // this adapter dead and tell the gateway — otherwise turns keep queueing
  // into a corpse and every channel waiter hangs forever.
  #watchExit(sess) {
    sess.handle.onExit(({ exitCode }) => {
      if (this.killed || this.dead || this.session !== sess) return;
      this.dead = true;
      this.exitCode = typeof exitCode === "number" ? exitCode : 1;
      logEvent("stdout", { kind: "soul-exit", session: this.opts.sessionUuid, code: this.exitCode, signal: null });
      try { this.opts.onExit?.(this.exitCode, null); } catch { /* ignore */ }
    });
  }

  /**
   * Queue one turn. Returns a PER-TURN promise resolving with THIS turn's
   * reply text (never rejecting — failures resolve as "[operative error] …"),
   * or false when the adapter is dead. Callers that await it get exactly the
   * reply of the turn they wrote — session-scoped waiters cross replies the
   * moment two turns are in flight (the Kanban tick dispatches cards
   * concurrently), so correlation MUST be per turn.
   * `.catch(() => {})` before chaining: one failed turn must not poison the
   * queue — a bare `.then` on a rejected promise would skip every later turn.
   */
  write(content, turnOpts) {
    if (this.killed || this.dead) return false;
    const turn = this.queue.catch(() => {}).then(() => this.#turn(content, turnOpts));
    this.queue = turn;
    return turn;
  }

  async #turn(content, turnOpts) {
    try {
      await this.ready;
    } catch (err) {
      // Spawn failed after this turn was queued — resolve with the failure
      // instead of leaving the channel hanging.
      return this.#emit(`[operative error] operative failed to start: ${err.message}`);
    }
    if (this.killed || this.dead || !this.session) {
      if (this.killed) return "";
      return this.#emit("[operative error] operative session is not running.");
    }
    try {
      // An explicit per-turn timeout (the Kanban Loop sends a generous one —
      // a real garrison-* phase runs far longer than the 5-min default).
      const outcome = await this.session.runTurn({ message: content, timeoutMs: turnOpts?.timeoutMs });
      return this.#emit(outcome.reply ?? "");
    } catch (err) {
      // Surface the failure as the turn's result so waiters resolve — an
      // error reply beats an infinite WORKING spinner.
      if (!this.session.isAlive()) this.dead = true;
      logEvent("stderr", { kind: "soul-turn-error", session: this.opts.sessionUuid, error: err.message });
      return this.#emit(`[operative error] ${err.message}`);
    }
  }

  #emit(text) {
    const ev = { type: "assistant", message: { content: [{ type: "text", text }] } };
    try { this.opts.onEvent?.(ev); } catch (err) {
      logEvent("stderr", { kind: "on-event-failed", session: this.opts.sessionUuid, error: err.message });
    }
    try { this.opts.onResult?.(text, { type: "result", result: text }); } catch (err) {
      logEvent("stderr", { kind: "on-result-failed", session: this.opts.sessionUuid, error: err.message });
    }
    return text;
  }

  kill(signal = "SIGTERM") {
    this.killed = true;
    this.exitCode = signal === "SIGKILL" ? 137 : 143;
    try { this.session?.dispose(); } catch { /* ignore */ }
    logEvent("stdout", { kind: "soul-exit", session: this.opts.sessionUuid, code: this.exitCode, signal });
    try { this.opts.onExit?.(this.exitCode, signal); } catch { /* ignore */ }
  }
}

export function writeUserTurn(child, content, turnOpts) {
  if (typeof child?.write === "function") return child.write(content, turnOpts);
  return false;
}

/**
 * Interactive-mode spawn: POST to Garrison Next.js's /api/interactive/spawn-soul-tab.
 * The endpoint opens a session tab in the Dev Env Fitting (port 27086), constructs the
 * claude command (incorporating tier flags), and types the initial prompt over
 * PTY. Returns a terminal_tab_id which the caller stores on the SessionState
 * so subsequent respawns / kills can target the same tab.
 */
export async function spawnInteractiveTab({
  nextBaseUrl,
  sessionUuid,
  spawnConfig,
  cwd,
  tierFlags,
  message,
  mcpConfigPath,
  soul,
  resume,
  promptPath
}) {
  if (!nextBaseUrl) {
    throw new Error("GARRISON_NEXT_BASE_URL not set — cannot spawn interactive-mode session");
  }
  const args = buildClaudeArgs({
    sessionUuid,
    spawnConfig,
    resume,
    tierFlags,
    mcpConfigPath,
    isOrchestrator: false,
    promptPath
  });
  const body = {
    session_id: sessionUuid,
    soul,
    cwd,
    args,
    message,
    mcp_config_path: mcpConfigPath
  };
  const response = await fetch(`${nextBaseUrl}/api/interactive/spawn-soul-tab`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`spawn-soul-tab failed: ${response.status} ${text.slice(0, 200)}`);
  }
  return await response.json();
}

function buildExtraArgs({ spawnConfig, tierFlags = [], mcpConfigPath, isOrchestrator }) {
  const args = [];
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  if (spawnConfig?.exclude_dynamic_sections) args.push("--exclude-dynamic-system-prompt-sections");
  if (spawnConfig?.allowed_tools && spawnConfig.allowed_tools.length > 0) {
    args.push("--allowedTools", spawnConfig.allowed_tools.join(","));
  }
  const disallowed = isOrchestrator
    ? disallowedToolsForOrchestrator(spawnConfig)
    : disallowedToolsForSoul(spawnConfig);
  if (disallowed.length > 0) args.push("--disallowedTools", disallowed.join(","));
  args.push(...tierFlags);
  return args;
}

export async function respawnInteractiveTab({
  nextBaseUrl,
  sessionUuid,
  terminalTabId,
  spawnConfig,
  tierFlags,
  mcpConfigPath,
  message,
  promptPath
}) {
  if (!nextBaseUrl) throw new Error("GARRISON_NEXT_BASE_URL not set");
  const args = buildClaudeArgs({
    sessionUuid,
    spawnConfig,
    resume: true,
    tierFlags,
    mcpConfigPath,
    isOrchestrator: false,
    promptPath
  });
  const body = {
    session_id: sessionUuid,
    terminal_tab_id: terminalTabId,
    args,
    message
  };
  const response = await fetch(`${nextBaseUrl}/api/interactive/respawn-soul-tab`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`respawn-soul-tab failed: ${response.status} ${text.slice(0, 200)}`);
  }
  return await response.json();
}

/**
 * Write a soul/orchestrator's system prompt to a temp file so we can pass it
 * via --append-system-prompt-file. We re-create per-spawn because the prompt
 * is identity-stable but file paths shouldn't be reused across reboots.
 */
export async function writePromptTempFile(sessionUuid, sourcePath) {
  const dir = process.env.TMPDIR || "/tmp";
  const target = path.join(dir, `garrison-prompt-${sessionUuid}.txt`);
  const contents = await fsp.readFile(sourcePath, "utf8");
  await fsp.writeFile(target, contents, "utf8");
  return target;
}

/**
 * Cancel the child's in-flight turn, backing the gateway's /claude/interrupt.
 *
 * The branch sent a stream-json `control_request` to the child's stdin. That no
 * longer applies: spawnHeadless now returns a PtySoulAdapter driving a real TUI
 * over a PTY, so the cancel is an ESC keystroke into that terminal — the same
 * key a human presses to stop a running turn. No-op (false) when the adapter has
 * no live session, so an interrupt against a dead operative can't throw.
 */
export function writeInterrupt(child) {
  const session = child?.session;
  if (!session || typeof session.writeKeys !== "function") return false;
  if (typeof session.isAlive === "function" && !session.isAlive()) return false;
  try {
    session.writeKeys("\x1b");
    return true;
  } catch {
    return false;
  }
}
