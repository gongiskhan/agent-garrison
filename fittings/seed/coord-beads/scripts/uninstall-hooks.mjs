#!/usr/bin/env node
// Cleanly and completely remove the coord-beads SessionStart hook from
// ~/.claude/settings.json. Removes ONLY the owner-tagged
// `_garrison: "fitting:coord-beads"` group(s) — never touches hand-authored or
// other-owner groups. Leaves no orphan. Idempotent (no-op if already absent).
//
// GARRISON_CLAUDE_SETTINGS_PATH overrides the settings path (sandbox/testability).

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const SETTINGS_PATH =
  process.env.GARRISON_CLAUDE_SETTINGS_PATH && process.env.GARRISON_CLAUDE_SETTINGS_PATH.trim().length > 0
    ? process.env.GARRISON_CLAUDE_SETTINGS_PATH
    : path.join(HOME, ".claude", "settings.json");

const OWNER = "fitting:coord-beads";

function safeParse(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  return {};
}

async function main() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    console.log("[coord-beads] no settings.json — nothing to remove");
    return;
  }
  const settings = safeParse(await fsp.readFile(SETTINGS_PATH, "utf8"));
  if (!settings.hooks || typeof settings.hooks !== "object") {
    console.log("[coord-beads] no hooks — nothing to remove");
    return;
  }
  let removed = 0;
  for (const [event, list] of Object.entries(settings.hooks)) {
    if (!Array.isArray(list)) continue;
    const before = list.length;
    settings.hooks[event] = list.filter((g) => !(g && g._garrison === OWNER));
    removed += before - settings.hooks[event].length;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  await fsp.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`[coord-beads] removed ${removed} ${OWNER} hook group(s) → ${SETTINGS_PATH}`);
}

main().catch((err) => {
  console.error("[coord-beads] uninstall-hooks failed:", err);
  process.exit(1);
});
