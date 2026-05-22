#!/usr/bin/env node
// Install Garrison session-view hooks into ~/.claude/settings.json.
// Idempotent: re-running strips any prior `_garrison: true` groups before adding fresh ones.
// Preserves all unrelated entries (memory-compiler, sequoias, user-defined).

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");
const SNAPSHOT_DIR = path.join(HOME, ".garrison", "snapshots");
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, "claude-settings.before-garrison.json");

const PORT = Number(process.env.GARRISON_SESSION_VIEW_PORT || 7081);
const HOOK_EVENTS = ["UserPromptSubmit", "Stop", "Notification", "PostToolUse"];

function buildHookCommand(event) {
  // Claude Code passes a JSON payload on stdin (session_id, transcript_path,
  // hook_event_name, cwd, ...). Forward it verbatim so /_hook can persist
  // the real Claude session_id alongside the Garrison-local row. Falls back
  // to a minimal payload if stdin is empty or Claude Code changes the
  // contract — server side handles both shapes.
  return [
    `payload=$(cat 2>/dev/null);`,
    `if [ -z "$payload" ]; then payload="{\\"cwd\\":\\"$CLAUDE_PROJECT_DIR\\"}"; fi;`,
    `curl -s -X POST 'http://127.0.0.1:${PORT}/_hook?event=${event}'`,
    `-H 'Content-Type: application/json'`,
    `-d "$payload"`,
    `> /dev/null 2>&1 || true`
  ].join(" ");
}

function safeParse(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  return {};
}

function stripGarrisonGroups(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object") return false;
  let removedAny = false;
  for (const [event, list] of Object.entries(settings.hooks)) {
    if (!Array.isArray(list)) continue;
    const before = list.length;
    settings.hooks[event] = list.filter((g) => !(g && g._garrison));
    if (settings.hooks[event].length !== before) removedAny = true;
  }
  return removedAny;
}

async function main() {
  await fsp.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fsp.mkdir(SNAPSHOT_DIR, { recursive: true });

  const existedBefore = fs.existsSync(SETTINGS_PATH);
  let originalText = existedBefore ? await fsp.readFile(SETTINGS_PATH, "utf8") : "";

  // First-install snapshot (preserved across re-runs)
  if (existedBefore && !fs.existsSync(SNAPSHOT_PATH)) {
    await fsp.writeFile(SNAPSHOT_PATH, originalText);
    console.log(`[install-hooks] snapshot saved to ${SNAPSHOT_PATH}`);
  }

  const settings = existedBefore ? safeParse(originalText) : {};
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  // Clean any prior _garrison groups so re-running is idempotent
  const stripped = stripGarrisonGroups(settings);
  if (stripped) console.log("[install-hooks] removed stale _garrison hook entries");

  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    settings.hooks[event].push({
      _garrison: true,
      matcher: "",
      hooks: [{ type: "command", command: buildHookCommand(event), timeout: 5 }]
    });
  }

  await fsp.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`[install-hooks] installed ${HOOK_EVENTS.length} _garrison hook groups → ${SETTINGS_PATH}`);
  for (const e of HOOK_EVENTS) {
    console.log(`  + ${e} → POST http://127.0.0.1:${PORT}/_hook`);
  }
}

main().catch((err) => {
  console.error("[install-hooks] failed:", err);
  process.exit(1);
});
