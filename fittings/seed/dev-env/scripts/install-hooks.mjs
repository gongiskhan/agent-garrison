#!/usr/bin/env node
// Install Garrison dev-env hooks into ~/.claude/settings.json.
// Owner-scoped: groups are tagged `_garrison: "fitting:dev-env"`, so this
// writer strips ONLY its own groups and never collides with other Garrison
// hook writers (memory, future hook fittings) or hand-authored hooks.
// Idempotent: re-running strips this owner's groups before adding fresh ones.
// Migration: also strips `fitting:session-view-sequoias` groups (dev-env
// absorbed that fitting's hook receiver) and any legacy bare
// `_garrison: true` groups the retired writer produced pre-migration.
// Preserves all unrelated entries (memory-compiler, user-defined).
//
// GARRISON_CLAUDE_SETTINGS_PATH overrides the settings path (testability).

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const CLAUDE_HOME = process.env.GARRISON_CLAUDE_HOME?.trim() || path.join(HOME, ".claude");
const GARRISON_HOME = process.env.GARRISON_HOME?.trim() || path.join(HOME, ".garrison");
const SETTINGS_PATH = process.env.GARRISON_CLAUDE_SETTINGS_PATH && process.env.GARRISON_CLAUDE_SETTINGS_PATH.trim().length > 0
  ? process.env.GARRISON_CLAUDE_SETTINGS_PATH
  : path.join(CLAUDE_HOME, "settings.json");
const SNAPSHOT_DIR = path.join(GARRISON_HOME, "snapshots");
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, "claude-settings.before-garrison.json");

// Setup hooks receive composition config through setupConfigEnv(), which
// projects dev-env's `port` key as DEV_ENV_PORT. Keep the older explicit
// override as a compatibility fallback for direct/manual installs.
const PORT = Number(process.env.DEV_ENV_PORT || process.env.GARRISON_DEV_ENV_PORT || 27086);
const HOOK_EVENTS = ["UserPromptSubmit", "Stop", "Notification", "PostToolUse"];
const OWNER = "fitting:dev-env";
// Owners whose groups this writer removes: itself (idempotence) and the
// retired session-view fitting it replaced.
const STRIP_OWNERS = new Set([OWNER, "fitting:session-view-sequoias"]);

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

// Strip the owners this writer manages (plus legacy bare-`true` groups, which
// only the retired session-view writer ever produced).
function stripOwnGroups(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object") return false;
  let removedAny = false;
  for (const [event, list] of Object.entries(settings.hooks)) {
    if (!Array.isArray(list)) continue;
    const before = list.length;
    settings.hooks[event] = list.filter((g) => !(g && (STRIP_OWNERS.has(g._garrison) || g._garrison === true)));
    if (settings.hooks[event].length !== before) removedAny = true;
  }
  return removedAny;
}

async function main() {
  await fsp.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fsp.mkdir(SNAPSHOT_DIR, { recursive: true });

  const existedBefore = fs.existsSync(SETTINGS_PATH);
  const originalText = existedBefore ? await fsp.readFile(SETTINGS_PATH, "utf8") : "";

  // First-install snapshot (preserved across re-runs)
  if (existedBefore && !fs.existsSync(SNAPSHOT_PATH)) {
    await fsp.writeFile(SNAPSHOT_PATH, originalText);
    console.log(`[install-hooks] snapshot saved to ${SNAPSHOT_PATH}`);
  }

  const settings = existedBefore ? safeParse(originalText) : {};
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  const stripped = stripOwnGroups(settings);
  if (stripped) console.log(`[install-hooks] removed stale garrison hook entries (${[...STRIP_OWNERS].join(", ")})`);

  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    settings.hooks[event].push({
      _garrison: OWNER,
      matcher: "",
      hooks: [{ type: "command", command: buildHookCommand(event), timeout: 5 }]
    });
  }

  await fsp.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`[install-hooks] installed ${HOOK_EVENTS.length} ${OWNER} hook groups → ${SETTINGS_PATH}`);
  for (const e of HOOK_EVENTS) {
    console.log(`  + ${e} → POST http://127.0.0.1:${PORT}/_hook`);
  }
}

main().catch((err) => {
  console.error("[install-hooks] failed:", err);
  process.exit(1);
});
