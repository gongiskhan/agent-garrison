#!/usr/bin/env node
// Verify hook for dev-env. Confirms:
//   - dist/index.html exists (build ran)
//   - node-pty is loadable (PTY spawning will work)
//   - the append prompt shipped with the package
//   - the state-file path is readable (or absent — both fine)
// Read-only: does NOT bind a port (the runner already does that at start
// time; verify must be idempotent / non-mutating).

import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const args = new Set(process.argv.slice(2));
const here = path.dirname(url.fileURLToPath(import.meta.url));
const distIndex = path.resolve(here, "..", "dist", "index.html");
const promptFile = path.resolve(here, "..", "prompts", "browser-pane.md");
const stateFile = path.join(os.homedir(), ".garrison", "sessions", "state.json");

if (!existsSync(distIndex)) {
  console.error(`[probe] dist not built: ${distIndex}`);
  process.exit(2);
}

if (!existsSync(promptFile)) {
  console.error(`[probe] append prompt missing: ${promptFile}`);
  process.exit(5);
}

try {
  await import("node-pty");
} catch (err) {
  console.error(`[probe] node-pty not loadable: ${err.message}`);
  process.exit(3);
}

if (existsSync(stateFile)) {
  try {
    const stat = statSync(stateFile);
    if (!stat.isFile()) {
      console.error(`[probe] not a file: ${stateFile}`);
      process.exit(4);
    }
  } catch (err) {
    console.error(`[probe] cannot stat state file: ${err.message}`);
    process.exit(4);
  }
}

void args; // --probe and bare invocations both print ok on success
console.log("ok");
process.exit(0);
