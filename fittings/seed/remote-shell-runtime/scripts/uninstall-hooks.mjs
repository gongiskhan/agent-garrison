#!/usr/bin/env node
// The inverse of install-hooks.mjs: removes only the entries this fitting
// added (matched by the hook script's own path appearing in the command),
// leaving every other entry in each file untouched. Does not remove the
// snapshot files or the hook script itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function homeDir(env) {
  return env.HOME?.trim() || os.homedir();
}

function cursorHome(env) {
  return env.GARRISON_CURSOR_HOME?.trim() || path.join(homeDir(env), ".cursor");
}

function codexHome(env) {
  return env.CODEX_HOME?.trim() || env.GARRISON_SHELLS_CODEX_HOME?.trim() || path.join(homeDir(env), ".codex");
}

function geminiHome(env) {
  return env.GEMINI_CLI_HOME?.trim() || env.GARRISON_SHELLS_GEMINI_HOME?.trim() || path.join(homeDir(env), ".gemini");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function removeByCommandSubstring(hooks, marker) {
  if (!hooks || typeof hooks !== "object") return false;
  let changed = false;
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const before = list.length;
    hooks[event] = list.filter((g) => {
      // Cursor shape: {command}. Claude/Codex/Gemini shape: {hooks:[{command}]}.
      if (typeof g?.command === "string") return !g.command.includes(marker);
      if (Array.isArray(g?.hooks)) {
        const kept = g.hooks.filter((h) => !String(h?.command ?? "").includes(marker));
        if (kept.length === g.hooks.length) return true;
        changed = true;
        g.hooks = kept;
        return kept.length > 0;
      }
      return true;
    });
    if (hooks[event].length !== before) changed = true;
    if (hooks[event].length === 0) delete hooks[event];
  }
  return changed;
}

export function uninstallHooks(env = process.env, log = console.log) {
  const marker = "agent-event-hook.sh";
  let removed = 0;
  for (const [name, home, key] of [
    ["claude", env.GARRISON_CLAUDE_HOME?.trim() || env.CLAUDE_CONFIG_DIR?.trim() || env.GARRISON_SHELLS_CLAUDE_HOME?.trim() || path.join(homeDir(env), ".claude"), "settings.json"],
    ["cursor", cursorHome(env), "hooks.json"],
    ["codex", codexHome(env), "hooks.json"],
    ["gemini", geminiHome(env), "settings.json"]
  ]) {
    const selected = new Set(String(env.GARRISON_SHARE_RUNTIMES || "").split(","));
    if (env.GARRISON_SHARE_TARGET && name === "cursor") continue;
    if (env.GARRISON_SHARE_TARGET === "user" && !selected.has(name === "claude" ? "claude-code" : name)) continue;
    const file = path.join(home, key);
    const cfg = readJson(file);
    if (!cfg) continue;
    if (removeByCommandSubstring(cfg.hooks, marker)) {
      writeJson(file, cfg);
      removed++;
      log(`removed shells hooks from ${file}`);
    }
  }
  return { removed };
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === path.resolve(process.argv[1]);
if (isMain) {
  uninstallHooks(process.env);
}
