#!/usr/bin/env node
// Install (and merge, never replace) the agent lifecycle hook into every CLI
// this node can see: Claude (~/.claude/settings.json), Cursor (~/.cursor/hooks.json), Codex (~/.codex/hooks.json)
// and Gemini (~/.gemini/settings.json). Same idea as csg-bootstrap.sh already
// used for Cursor on the remote transport - here for the LOCAL transport, so
// hook-driven status works for sessions started directly in a terminal too.
//
// Idempotent (matched by exact command string), preserves every unrelated
// entry byte-for-byte in meaning, and snapshots each file ONCE before its
// first edit. Claude's process registry proves existence, but older clients
// omit busy/idle state; these additive hooks report native turn lifecycle.
//
// GARRISON_REMOTESHELLRUNTIME_INSTALL_HOOKS=false (or win32) skips entirely.
//
// The launcher's homes are authoritative. Explicit sharing runs this same
// setup with the selected user homes and GARRISON_SHARE_RUNTIMES; ordinary
// Garrison setup must never add hooks to terminal config.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { garrisonHome } from "../lib/transports.mjs";
import { buildEventHook } from "../lib/sessions.mjs";

function homeDir(env) {
  return env.HOME?.trim() || os.homedir();
}

function cursorHome(env) {
  return env.GARRISON_CURSOR_HOME?.trim() || path.join(homeDir(env), ".cursor");
}

function codexHome(env) {
  return env.CODEX_HOME?.trim() || env.GARRISON_SHELLS_CODEX_HOME?.trim() || path.join(homeDir(env), ".codex");
}

function claudeHome(env) {
  return env.GARRISON_CLAUDE_HOME?.trim() || env.CLAUDE_CONFIG_DIR?.trim() || env.GARRISON_SHELLS_CLAUDE_HOME?.trim() || path.join(homeDir(env), ".claude");
}

function geminiHome(env) {
  return env.GEMINI_CLI_HOME?.trim() || env.GARRISON_SHELLS_GEMINI_HOME?.trim() || path.join(homeDir(env), ".gemini");
}

function hookScriptPath(env) {
  return path.join(garrisonHome(env), "shells", "agent-event-hook.sh");
}

function readJson(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing linked runtime config: ${file}`);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid runtime config: ${file}`);
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function snapshotOnce(garrisonHomeDir, name, file) {
  const dest = path.join(garrisonHomeDir, "snapshots", `shells-${name}.before.json`);
  if (fs.existsSync(dest)) return;
  const current = readJson(file);
  if (current === null) return; // nothing existed to preserve
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(current, null, 2)}\n`);
}

/** Ensure `settings.hooks[event]` (Claude-settings shape, which Codex and
 *  Gemini both borrow) contains one entry whose command is EXACTLY `command`.
 *  Every other entry is left untouched. Returns whether anything changed. */
function ensureClaudeShapedHook(hooks, event, command, matcher = "") {
  const list = Array.isArray(hooks[event]) ? hooks[event] : [];
  const already = list.some(
    (g) => Array.isArray(g?.hooks) && g.hooks.some((h) => h?.command === command)
  );
  if (already) {
    hooks[event] = list;
    return false;
  }
  hooks[event] = [...list, { _garrison: "fitting:remote-shell-runtime", matcher, hooks: [{ type: "command", command, timeout: 5 }] }];
  return true;
}

function installCursorHooks(env, garrisonHomeDir, hookPath, log) {
  const home = cursorHome(env);
  if (!fs.existsSync(home)) return;
  const file = path.join(home, "hooks.json");
  snapshotOnce(garrisonHomeDir, "cursor", file);
  const cfg = readJson(file) ?? { version: 1, hooks: {} };
  cfg.version ??= 1;
  cfg.hooks ??= {};
  const stopCmd = `${hookPath} agent-stop cursor`;
  const startCmd = `${hookPath} agent-start cursor`;
  const stopList = Array.isArray(cfg.hooks.stop) ? cfg.hooks.stop : [];
  const startList = Array.isArray(cfg.hooks.beforeSubmitPrompt) ? cfg.hooks.beforeSubmitPrompt : [];
  let changed = false;
  if (!stopList.some((h) => h?.command === stopCmd)) {
    cfg.hooks.stop = [...stopList, { command: stopCmd }];
    changed = true;
  } else {
    cfg.hooks.stop = stopList;
  }
  if (!startList.some((h) => h?.command === startCmd)) {
    cfg.hooks.beforeSubmitPrompt = [...startList, { command: startCmd }];
    changed = true;
  } else {
    cfg.hooks.beforeSubmitPrompt = startList;
  }
  // Refresh the exact conversation's activity during a long turn. These are
  // observational hooks only: no output and no permission decision.
  for (const name of ["preToolUse", "postToolUse", "afterAgentThought"]) {
    const command = `${hookPath} agent-start cursor`;
    const list = Array.isArray(cfg.hooks[name]) ? cfg.hooks[name] : [];
    if (!list.some((h) => h?.command === command)) {
      cfg.hooks[name] = [...list, { command }];
      changed = true;
    }
  }
  const endCommand = `${hookPath} session-end cursor`;
  const endList = Array.isArray(cfg.hooks.sessionEnd) ? cfg.hooks.sessionEnd : [];
  if (!endList.some((h) => h?.command === endCommand)) {
    cfg.hooks.sessionEnd = [...endList, { command: endCommand }];
    changed = true;
  }
  if (changed) {
    writeJson(file, cfg);
    log(`cursor hooks.json updated (${file})`);
  } else {
    log("cursor hooks.json already current");
  }
}

function installClaudeHooks(env, garrisonHomeDir, hookPath, log) {
  const home = claudeHome(env);
  if (!fs.existsSync(home)) return;
  const file = path.join(home, "settings.json");
  snapshotOnce(garrisonHomeDir, "claude", file);
  const cfg = readJson(file) ?? {};
  cfg.hooks ??= {};
  let changed = false;
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
    changed = ensureClaudeShapedHook(cfg.hooks, event, `${hookPath} agent-start claude`) || changed;
  }
  changed = ensureClaudeShapedHook(cfg.hooks, "Stop", `${hookPath} agent-stop claude`) || changed;
  changed = ensureClaudeShapedHook(cfg.hooks, "SessionEnd", `${hookPath} session-end claude`) || changed;
  if (changed) { writeJson(file, cfg); log(`shells hooks installed (${file})`); }
}

function installCodexHooks(env, garrisonHomeDir, hookPath, log) {
  const home = codexHome(env);
  if (!fs.existsSync(home)) return;
  const file = path.join(home, "hooks.json");
  snapshotOnce(garrisonHomeDir, "codex", file);
  const cfg = readJson(file) ?? { hooks: {} };
  cfg.hooks ??= {};
  let changed = false;
  changed = ensureClaudeShapedHook(cfg.hooks, "UserPromptSubmit", `${hookPath} agent-start codex`) || changed;
  changed = ensureClaudeShapedHook(cfg.hooks, "Stop", `${hookPath} agent-stop codex`) || changed;
  changed = ensureClaudeShapedHook(cfg.hooks, "SessionStart", `${hookPath} session-start codex`) || changed;
  changed = ensureClaudeShapedHook(cfg.hooks, "SessionEnd", `${hookPath} session-end codex`) || changed;
  if (changed) {
    writeJson(file, cfg);
    log(`codex hooks.json updated (${file})`);
    log("codex trusts new hooks interactively on next launch (this writer never touches config.toml [hooks.state])");
  } else {
    log("codex hooks.json already current");
  }
}

function installGeminiHooks(env, garrisonHomeDir, hookPath, log) {
  const home = geminiHome(env);
  if (!fs.existsSync(home)) return;
  const file = path.join(home, "settings.json");
  snapshotOnce(garrisonHomeDir, "gemini", file);
  const cfg = readJson(file) ?? {};
  cfg.hooks ??= {};
  let changed = false;
  changed = ensureClaudeShapedHook(cfg.hooks, "BeforeAgent", `${hookPath} agent-start gemini`) || changed;
  changed = ensureClaudeShapedHook(cfg.hooks, "AfterAgent", `${hookPath} agent-stop gemini`) || changed;
  changed = ensureClaudeShapedHook(cfg.hooks, "SessionStart", `${hookPath} session-start gemini`) || changed;
  changed = ensureClaudeShapedHook(cfg.hooks, "SessionEnd", `${hookPath} session-end gemini`) || changed;
  if (changed) {
    writeJson(file, cfg);
    log(`gemini settings.json updated (${file})`);
  } else {
    log("gemini settings.json already current");
  }
}

export function installHooks(env = process.env, log = console.log) {
  if (String(env.GARRISON_REMOTESHELLRUNTIME_INSTALL_HOOKS ?? "true").trim() === "false") {
    log("shells hook install skipped (GARRISON_REMOTESHELLRUNTIME_INSTALL_HOOKS=false)");
    return { skipped: true };
  }
  if (process.platform === "win32") {
    log("shells hook install skipped (win32)");
    return { skipped: true };
  }
  const garrisonHomeDir = garrisonHome(env);
  const hookPath = hookScriptPath(env);
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  const eventsFile = path.join(garrisonHomeDir, "shells", "events.jsonl");
  const script = buildEventHook(eventsFile);
  const current = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf8") : null;
  if (current !== script) {
    fs.writeFileSync(hookPath, script, { mode: 0o755 });
    fs.chmodSync(hookPath, 0o755);
    log(`shells hook script written (${hookPath})`);
  }

  const shared = env.GARRISON_SHARE_TARGET === "user" ? new Set(String(env.GARRISON_SHARE_RUNTIMES || "").split(",")) : null;
  if (!shared || shared.has("claude-code")) installClaudeHooks(env, garrisonHomeDir, hookPath, log);
  if (!env.GARRISON_SHARE_TARGET) installCursorHooks(env, garrisonHomeDir, hookPath, log);
  if (!shared || shared.has("codex")) installCodexHooks(env, garrisonHomeDir, hookPath, log);
  if (!shared || shared.has("gemini")) installGeminiHooks(env, garrisonHomeDir, hookPath, log);
  return { skipped: false, hookPath };
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === path.resolve(process.argv[1]);
if (isMain) {
  installHooks(process.env);
}
