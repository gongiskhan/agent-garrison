#!/usr/bin/env node
// install-probe-hooks.mjs — register the Improver Probe hooks into
// ~/.claude/settings.json (GARRISON-FLOW-V2 S8). Mirrors the dev-env install-hooks
// contract exactly: owner-scoped groups tagged `_garrison: "fitting:improver-probe"`,
// additive (every unrelated group — dev-env, memory, goal-loop, hand-authored — is
// preserved) and idempotent (this owner's groups are stripped before fresh ones are
// added, so re-running setup never duplicates).
//
// Two groups, both carrying the ABSOLUTE path of the installed probe scripts so the
// hook works regardless of the operative's cwd:
//   Stop        (matcher "")               → bash probe-stop-hook.sh   (gate + relay)
//   PostToolUse (matcher "AskUserQuestion") → node probe-capture.mjs    (answer capture)
//
// GARRISON_CLAUDE_SETTINGS_PATH overrides the settings path (testability).

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../improver/scripts
const HOME = os.homedir();
const CLAUDE_HOME = process.env.GARRISON_CLAUDE_HOME?.trim() || path.join(HOME, ".claude");
const SETTINGS_PATH =
  process.env.GARRISON_CLAUDE_SETTINGS_PATH && process.env.GARRISON_CLAUDE_SETTINGS_PATH.trim().length > 0
    ? process.env.GARRISON_CLAUDE_SETTINGS_PATH
    : path.join(CLAUDE_HOME, "settings.json");
const SNAPSHOT_DIR = path.join(process.env.GARRISON_HOME || path.join(HOME, ".garrison"), "snapshots");
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, "claude-settings.before-improver-probe.json");

const OWNER = "fitting:improver-probe";
const STOP_HOOK = path.join(HERE, "probe-stop-hook.sh");
const CAPTURE_HOOK = path.join(HERE, "probe-capture.mjs");

function safeParse(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  return {};
}

// Strip only this owner's groups (idempotence). Every other entry is preserved.
function stripOwnGroups(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object") return false;
  let removed = false;
  for (const [event, list] of Object.entries(settings.hooks)) {
    if (!Array.isArray(list)) continue;
    const before = list.length;
    settings.hooks[event] = list.filter((g) => !(g && g._garrison === OWNER));
    if (settings.hooks[event].length !== before) removed = true;
  }
  return removed;
}

function addGroup(settings, event, group) {
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  settings.hooks[event].push(group);
}

async function main() {
  await fsp.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fsp.mkdir(SNAPSHOT_DIR, { recursive: true });

  const existedBefore = fs.existsSync(SETTINGS_PATH);
  const originalText = existedBefore ? await fsp.readFile(SETTINGS_PATH, "utf8") : "";
  if (existedBefore && !fs.existsSync(SNAPSHOT_PATH)) {
    await fsp.writeFile(SNAPSHOT_PATH, originalText);
    console.log(`[install-probe-hooks] snapshot saved to ${SNAPSHOT_PATH}`);
  }

  const settings = existedBefore ? safeParse(originalText) : {};
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  if (stripOwnGroups(settings)) console.log(`[install-probe-hooks] removed stale ${OWNER} hook groups`);

  addGroup(settings, "Stop", {
    _garrison: OWNER,
    matcher: "",
    hooks: [{ type: "command", command: `bash ${STOP_HOOK}`, timeout: 15 }],
  });
  addGroup(settings, "PostToolUse", {
    _garrison: OWNER,
    matcher: "AskUserQuestion",
    hooks: [{ type: "command", command: `node ${CAPTURE_HOOK}`, timeout: 10 }],
  });

  await fsp.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`[install-probe-hooks] installed ${OWNER} Stop + PostToolUse(AskUserQuestion) hooks → ${SETTINGS_PATH}`);
}

main().catch((err) => {
  console.error("[install-probe-hooks] failed:", err);
  process.exit(1);
});
