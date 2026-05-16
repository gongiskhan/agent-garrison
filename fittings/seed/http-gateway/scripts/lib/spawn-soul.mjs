// Spawn a Claude Code subprocess for a Soul (or the Orchestrator).
// Two modes:
//   - "headless": spawn `claude` CLI directly here with stream-JSON I/O.
//                 Stdout events republish to the channel hub; on `result`,
//                 resolve waiters and set lastSummary.
//   - "workbench": delegate to Garrison Next.js's /api/workbench/spawn-soul-tab
//                  which opens a PTY in the Workbench panel. We then install
//                  a JSONL watcher to extract summary feedback.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fsp from "node:fs/promises";
import { logEvent } from "./log.mjs";

const COMMON_FLAGS = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--permission-mode", "bypassPermissions"
];

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
 * Build the claude CLI argument list for a given soul SpawnConfig + tier flags.
 * The returned array is what gets passed to spawn("claude", ...).
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

/**
 * Spawn a headless claude subprocess. Wires stdout → stream-JSON parser →
 * channels.publish + session lifecycle hooks. Returns the child handle.
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
  const args = buildClaudeArgs({
    sessionUuid,
    spawnConfig,
    resume,
    tierFlags,
    mcpConfigPath,
    isOrchestrator,
    promptPath
  });
  const env = { ...process.env };
  if (cwd === undefined) {
    logEvent("stderr", { kind: "spawn-soul-warn", message: "no cwd provided", session: sessionUuid });
  }
  const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

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
      try { onEvent?.(ev); } catch (err) {
        logEvent("stderr", { kind: "on-event-failed", session: sessionUuid, error: err.message });
      }
      if (ev.type === "result") {
        const text = extractResultText(ev);
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

  return child;
}

export function writeUserTurn(child, content) {
  if (!child?.stdin || child.stdin.destroyed) return false;
  const line = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
  return child.stdin.write(line);
}

function extractResultText(ev) {
  if (typeof ev.result === "string") return ev.result;
  return "";
}

/**
 * Workbench-mode spawn: POST to Garrison Next.js's /api/workbench/spawn-soul-tab.
 * The endpoint opens a TrenchesPanel-style tab in /workbench, constructs the
 * claude command (incorporating tier flags), and types the initial prompt over
 * PTY. Returns a terminal_tab_id which the caller stores on the SessionState
 * so subsequent respawns / kills can target the same tab.
 */
export async function spawnWorkbenchTab({
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
    throw new Error("GARRISON_NEXT_BASE_URL not set — cannot spawn workbench-mode session");
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
  const response = await fetch(`${nextBaseUrl}/api/workbench/spawn-soul-tab`, {
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

export async function respawnWorkbenchTab({
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
  const response = await fetch(`${nextBaseUrl}/api/workbench/respawn-soul-tab`, {
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
