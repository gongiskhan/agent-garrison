#!/usr/bin/env node
// Install the coord-mcp coordination hook into ~/.claude/settings.json at USER
// scope (SessionStart + UserPromptSubmit), owner-tagged `_garrison:
// "fitting:coord-mcp"`. Injects the repo-scoped digest + the begin_planning nudge
// on every claude run (direct + orchestrator). Composes with coord-beads' bd-prime
// SessionStart hook (different owner, complementary content — no double-inject of
// the same content).
//
// Idempotent (strips its own owner groups first). Never clobbers a corrupt
// settings.json (aborts). Fail-open hook command (guarded + `|| true`).
// GARRISON_CLAUDE_SETTINGS_PATH overrides the path (sandbox/testability).
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const SETTINGS_PATH =
  process.env.GARRISON_CLAUDE_SETTINGS_PATH && process.env.GARRISON_CLAUDE_SETTINGS_PATH.trim().length > 0
    ? process.env.GARRISON_CLAUDE_SETTINGS_PATH
    : path.join(HOME, ".claude", "settings.json");

const OWNER = "fitting:coord-mcp";
const EVENTS = ["SessionStart", "UserPromptSubmit"];
const HOOK_SCRIPT = path.join(__dirname, "coord-hook.mjs");
// Guarded + fail-open; stdin (the hook payload) flows through to coord-hook.mjs.
const HOOK_COMMAND = `[ -f ${HOOK_SCRIPT} ] && ${process.execPath} ${HOOK_SCRIPT} || true`;

function parseExistingOrThrow(text) {
  const t = text.trim();
  if (t.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`refusing to write: settings.json is not valid JSON (${e.message}); leaving it untouched`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("refusing to write: settings.json is not a JSON object; leaving it untouched");
  }
  return parsed;
}

function stripOwn(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object") return 0;
  let removed = 0;
  for (const [event, list] of Object.entries(settings.hooks)) {
    if (!Array.isArray(list)) continue;
    const before = list.length;
    settings.hooks[event] = list.filter((g) => !(g && g._garrison === OWNER));
    removed += before - settings.hooks[event].length;
  }
  return removed;
}

async function main() {
  await fsp.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  const existed = fs.existsSync(SETTINGS_PATH);
  const settings = existed ? parseExistingOrThrow(await fsp.readFile(SETTINGS_PATH, "utf8")) : {};
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  const removed = stripOwn(settings);
  if (removed) console.log(`[coord-mcp] removed ${removed} stale ${OWNER} hook group(s)`);

  for (const event of EVENTS) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    settings.hooks[event].push({ _garrison: OWNER, matcher: "", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 10 }] });
  }

  await fsp.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`[coord-mcp] installed ${OWNER} hooks (${EVENTS.join(", ")}) → ${SETTINGS_PATH}`);
}

main().catch((err) => {
  console.error("[coord-mcp] install-hook failed:", err.message);
  process.exit(1);
});
