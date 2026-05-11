#!/usr/bin/env node
// node-pty ships prebuilt `spawn-helper` binaries without the executable bit
// in some npm registry uploads. macOS rejects them with "posix_spawnp failed"
// at first call. We restore +x on the prebuilds.

import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const prebuildsDir = join(here, "..", "node_modules", "node-pty", "prebuilds");

if (!existsSync(prebuildsDir)) {
  // node-pty not installed (e.g. running this script before the dep is added)
  process.exit(0);
}

let touched = 0;
for (const platform of readdirSync(prebuildsDir)) {
  const helper = join(prebuildsDir, platform, "spawn-helper");
  if (existsSync(helper)) {
    chmodSync(helper, 0o755);
    touched += 1;
  }
}
if (touched > 0) {
  console.log(`[postinstall] chmod +x on ${touched} node-pty spawn-helper(s)`);
}
