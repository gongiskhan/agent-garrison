#!/usr/bin/env node
// Remove all `_garrison: true` matcher-groups from ~/.claude/settings.json.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");

async function main() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    console.log("[uninstall-hooks] no settings.json found; nothing to do");
    return;
  }
  const text = await fsp.readFile(SETTINGS_PATH, "utf8");
  let settings;
  try { settings = JSON.parse(text); } catch {
    console.error("[uninstall-hooks] settings.json is not valid JSON; aborting");
    process.exit(1);
  }
  if (!settings.hooks || typeof settings.hooks !== "object") {
    console.log("[uninstall-hooks] no hooks block; nothing to do");
    return;
  }
  let removed = 0;
  for (const [event, list] of Object.entries(settings.hooks)) {
    if (!Array.isArray(list)) continue;
    const before = list.length;
    settings.hooks[event] = list.filter((g) => !(g && g._garrison));
    removed += before - settings.hooks[event].length;
  }
  await fsp.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`[uninstall-hooks] removed ${removed} _garrison hook group(s) from ${SETTINGS_PATH}`);
}

main().catch((err) => {
  console.error("[uninstall-hooks] failed:", err);
  process.exit(1);
});
