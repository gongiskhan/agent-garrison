#!/usr/bin/env node
// Verify hook for session-view-sequoias. Confirms:
//   - dist/index.html exists (build ran)
//   - the state-file path is readable (or absent — both fine)
//   - prints "ok" on success
//
// Does NOT bind a port (the runner already does that at start time, and the
// verify hook must be idempotent / non-mutating).

import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const args = new Set(process.argv.slice(2));
const isProbe = args.has("--probe");

const here = path.dirname(url.fileURLToPath(import.meta.url));
const distIndex = path.resolve(here, "..", "dist", "index.html");
const stateFile = path.join(os.homedir(), ".garrison", "sessions", "state.json");

if (!existsSync(distIndex)) {
  console.error(`[probe] dist not built: ${distIndex}`);
  process.exit(2);
}

if (existsSync(stateFile)) {
  try {
    const stat = statSync(stateFile);
    if (!stat.isFile()) {
      console.error(`[probe] not a file: ${stateFile}`);
      process.exit(3);
    }
  } catch (err) {
    console.error(`[probe] cannot stat state file: ${err.message}`);
    process.exit(4);
  }
}

if (isProbe) {
  console.log("ok");
  process.exit(0);
} else {
  console.log("ok (--probe not passed, returning ok anyway)");
  process.exit(0);
}
