#!/usr/bin/env node
// Verify hook for dev-env. Confirms:
//   - dist/index.html exists (build ran)
//   - node-pty is loadable (PTY spawning will work)
//   - the append prompt shipped with the package
//   - the state-file path is readable (or absent — both fine)
// Also reports (non-fatally) whether tmux is available — its presence decides
// whether sessions are crash-persistent, but its absence is fine (direct PTY
// fallback). Read-only: does NOT bind a port (the runner already does that at
// start time; verify must be idempotent / non-mutating).

import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const args = new Set(process.argv.slice(2));
const here = path.dirname(url.fileURLToPath(import.meta.url));
const distIndex = path.resolve(here, "..", "dist", "index.html");
const promptFile = path.resolve(here, "..", "prompts", "browser-pane.md");
const stateFile = path.join(
  process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"),
  "sessions",
  "state.json"
);

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

// Phase 2 rich chat: the claude-pty lib (mirror/screen helpers) + headless
// xterm must resolve, and the chat stylesheet must be present in dist.
try {
  await import("@garrison/claude-pty");
  await import("@xterm/headless");
} catch (err) {
  console.error(`[probe] rich-chat deps not loadable: ${err.message}`);
  process.exit(6);
}
const distCss = path.resolve(here, "..", "dist", "dev-env.css");
if (!existsSync(distCss)) {
  console.error(`[probe] dist css missing: ${distCss}`);
  process.exit(7);
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

// tmux is optional. Report which PTY backing the server will use, but never
// fail on its absence — `auto`/`off` both run fine without it.
try {
  const ver = String(execFileSync("tmux", ["-V"], { encoding: "utf8" })).trim();
  console.error(`[probe] ${ver} available — sessions will survive a dev-env restart`);
} catch {
  console.error("[probe] tmux not found — direct PTY fallback (sessions won't survive a dev-env restart)");
}

void args; // --probe and bare invocations both print ok on success
console.log("ok");
process.exit(0);
