#!/usr/bin/env node
// Install (and merge, never replace) the agent lifecycle hook into every CLI
// this node can see: Cursor (~/.cursor/hooks.json), Codex (~/.codex/hooks.json)
// and Gemini (~/.gemini/settings.json). Same idea as csg-bootstrap.sh already
// used for Cursor on the remote transport - here for the LOCAL transport, so
// hook-driven status works for sessions started directly in a terminal too.
//
// Idempotent (matched by exact command string), preserves every unrelated
// entry byte-for-byte in meaning, and snapshots each file ONCE before its
// first edit. Never touches Claude Code's own hooks - dev-env already owns
// those, and the Claude live registry already gives honest status with no
// hook needed.
//
// GARRISON_REMOTESHELLRUNTIME_INSTALL_HOOKS=false (or win32) skips entirely.
// Env overrides for testability: HOME, GARRISON_HOME, GARRISON_CURSOR_HOME,
// CODEX_HOME, GEMINI_CLI_HOME.

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
  return env.CODEX_HOME?.trim() || path.join(homeDir(env), ".codex");
}

function geminiHome(env) {
  return env.GEMINI_CLI_HOME?.trim() || path.join(homeDir(env), ".gemini");
}

function hookScriptPath(env) {
  return path.join(garrisonHome(env), "shells", "agent-event-hook.sh");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
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
  hooks[event] = [...list, { matcher, hooks: [{ type: "command", command, timeout: 5 }] }];
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
  if (changed) {
    writeJson(file, cfg);
    log(`cursor hooks.json updated (${file})`);
  } else {
    log("cursor hooks.json already current");
  }
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

  installCursorHooks(env, garrisonHomeDir, hookPath, log);
  installCodexHooks(env, garrisonHomeDir, hookPath, log);
  installGeminiHooks(env, garrisonHomeDir, hookPath, log);
  return { skipped: false, hookPath };
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === path.resolve(process.argv[1]);
if (isMain) {
  installHooks(process.env);
}
