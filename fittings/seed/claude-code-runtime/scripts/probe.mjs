#!/usr/bin/env node
// Claude Code runtime probe (READ-ONLY verify hook).
//
// The Claude Code runtime is the node-pty + @xterm/headless substrate that
// drives the real interactive Claude Code TUI. Its one hard prerequisite is the
// `claude` CLI on PATH (the same binary the runner's spawnClaude path requires).
// This probe confirms that without spawning the TUI or mutating anything, then
// prints "ok" so the runner's verify step can prove the runtime is usable.
import { existsSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";

/** Return the first executable named `bin` found on PATH, or null. */
function onPath(bin) {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, bin);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // unreadable PATH entry — skip
    }
  }
  return null;
}

function findClaude() {
  return onPath("claude") || onPath("claude.cmd") || onPath("claude.exe");
}

const found = findClaude();
if (found) {
  console.log("ok");
  process.exit(0);
}

console.error(
  "claude-code-runtime: the `claude` CLI was not found on PATH. " +
    "Install Claude Code (https://claude.com/claude-code) to use this runtime."
);
process.exit(1);
