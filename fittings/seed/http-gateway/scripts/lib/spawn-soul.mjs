// Spawn a Claude Code subprocess for a Soul (or the Orchestrator).
// Two modes:
//   - "headless": spawn `claude` directly with stream-JSON I/O (one persistent
//                 process, multi-turn over stdin). Stdout events republish to the
//                 channel hub; on `result`, resolve waiters and set lastSummary.
//                 This replaced the PTY screen-scrape engine: deterministic turn
//                 boundaries (no settle delay, no 5-min hangs) and token-fast.
//   - "interactive": delegate to Garrison Next.js's /api/interactive/spawn-soul-tab
//                  which opens a PTY in the Interactive panel (real TUI). We then
//                  install a JSONL watcher to extract summary feedback.

import { spawn } from "node:child_process";
import path from "node:path";
import fsp from "node:fs/promises";
import { logEvent } from "./log.mjs";

// Flags for the interactive TUI args (buildClaudeArgs). The headless stream-JSON
// args are built separately in buildHeadlessArgs.
const COMMON_FLAGS = ["--permission-mode", "bypassPermissions"];

const GARRISON_TOOLS_DISALLOWED_FOR_SOULS = [
  "mcp__garrison__talk_to",
  "mcp__garrison__wait_for",
  "mcp__garrison__list_active_sessions",
  "mcp__garrison__end_session",
  "mcp__garrison__list_workdirs",
  "mcp__garrison__list_worktrees",
  "mcp__garrison__create_worktree",
  "mcp__garrison__get_worktree",
  "mcp__garrison__close_worktree"
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

// Build the headless stream-JSON arg list. One persistent `claude` process reads
// user turns from stdin and emits JSON events on stdout — deterministic turn ends
// (no PTY screen-scrape), so it's fast and never hangs the 5-min default.
function buildHeadlessArgs({ sessionUuid, spawnConfig, resume, tierFlags = [], mcpConfigPath, isOrchestrator, promptPath }) {
  const args = [
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions"
  ];
  // Stream token-level text deltas (stream_event) so the orchestrator's reply can
  // be spoken sentence-by-sentence AS it generates, not delivered whole at the
  // end. Only the orchestrator needs it — souls ignore raw events (onEvent noop)
  // and publish one clean summary on result, so enabling it for them is wasted
  // stdout.
  if (isOrchestrator) args.push("--include-partial-messages");
  if (spawnConfig?.model) args.push("--model", String(spawnConfig.model));
  if (resume) args.push("--resume", sessionUuid);
  else args.push("--session-id", sessionUuid);
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  if (promptPath) args.push("--append-system-prompt-file", promptPath);
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

/**
 * Spawn a headless claude subprocess with stream-JSON I/O. Wires stdout → JSON
 * parser → onEvent (every event) + onResult (on `result`). The returned handle is
 * a Node ChildProcess (.kill / .exitCode / .stdin), plus getClaudeSessionId().
 */
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
  const args = buildHeadlessArgs({ sessionUuid, spawnConfig, resume, tierFlags, mcpConfigPath, isOrchestrator, promptPath });
  if (cwd === undefined) {
    logEvent("stderr", { kind: "spawn-soul-warn", message: "no cwd provided", session: sessionUuid });
  }
  const child = spawn("claude", args, { cwd, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  let claudeSessionId = null;
  let stdoutBuf = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch {
        logEvent("stdout", { kind: "non-json-line", session: sessionUuid, line: line.slice(0, 200) });
        continue;
      }
      if (ev?.session_id && !claudeSessionId) {
        claudeSessionId = ev.session_id;
        logEvent("stdout", { kind: "soul-ready", session: sessionUuid, claude_session: claudeSessionId });
      }
      try { onEvent?.(ev); } catch (err) {
        logEvent("stderr", { kind: "on-event-failed", session: sessionUuid, error: err.message });
      }
      if (ev.type === "result") {
        const text = typeof ev.result === "string" ? ev.result : "";
        try { onResult?.(text, ev); } catch (err) {
          logEvent("stderr", { kind: "on-result-failed", session: sessionUuid, error: err.message });
        }
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    logEvent("stderr", { kind: "soul-stderr", session: sessionUuid, line: chunk.toString().slice(0, 500) });
  });
  child.on("exit", (code, signal) => {
    logEvent("stdout", { kind: "soul-exit", session: sessionUuid, code, signal });
    try { onExit?.(code, signal); } catch { /* ignore */ }
  });
  child.on("error", (err) => {
    logEvent("stderr", { kind: "soul-error", session: sessionUuid, error: err.message });
  });
  child.getClaudeSessionId = () => claudeSessionId;
  return child;
}

export function writeUserTurn(child, content) {
  if (!child?.stdin || child.stdin.destroyed) return false;
  const line = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
  return child.stdin.write(line);
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
  worktreeId,
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
    worktree_id: worktreeId,
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
