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

class PtySoulAdapter {
  constructor(opts) {
    this.opts = opts;
    this.session = null;
    this.exitCode = null;
    this.killed = false;
    this.queue = Promise.resolve();
    this.ready = this.#start();
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
    this.session = await OperativePtySession.spawn({
      compositionDir: cwd ?? process.cwd(),
      appendSystemPromptFile: promptPath,
      sessionUuid: resume ? undefined : sessionUuid,
      resumeSessionId: resume ? sessionUuid : undefined,
      permissionMode: "bypassPermissions",
      extraArgs,
      cols: 140,
      rows: 42
    });
    logEvent("stdout", { kind: "soul-ready", session: sessionUuid, claude_session: this.session.getClaudeSessionId() });
  }

  write(content) {
    if (this.killed) return false;
    this.queue = this.queue.then(() => this.#turn(content));
    this.queue.catch((err) => {
      logEvent("stderr", { kind: "soul-turn-error", session: this.opts.sessionUuid, error: err.message });
    });
    return true;
  }

  async #turn(content) {
    await this.ready;
    if (this.killed || !this.session) return;
    const outcome = await this.session.runTurn({ message: content });
    const text = outcome.reply ?? "";
    const ev = { type: "assistant", message: { content: [{ type: "text", text }] } };
    try { this.opts.onEvent?.(ev); } catch (err) {
      logEvent("stderr", { kind: "on-event-failed", session: this.opts.sessionUuid, error: err.message });
    }
    try { this.opts.onResult?.(text, { type: "result", result: text }); } catch (err) {
      logEvent("stderr", { kind: "on-result-failed", session: this.opts.sessionUuid, error: err.message });
    }
  }

  kill(signal = "SIGTERM") {
    this.killed = true;
    this.exitCode = signal === "SIGKILL" ? 137 : 143;
    try { this.session?.dispose(); } catch { /* ignore */ }
    logEvent("stdout", { kind: "soul-exit", session: this.opts.sessionUuid, code: this.exitCode, signal });
    try { this.opts.onExit?.(this.exitCode, signal); } catch { /* ignore */ }
  }
}

export function writeUserTurn(child, content) {
  if (typeof child?.write === "function") return child.write(content);
  return false;
}

/**
 * Interactive-mode spawn: POST to Garrison Next.js's /api/interactive/spawn-soul-tab.
 * The endpoint opens a terminal tab on the Terminal Fitting (port 7078), constructs the
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
