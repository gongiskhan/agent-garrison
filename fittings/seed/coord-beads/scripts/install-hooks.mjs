#!/usr/bin/env node
// Install the Beads coordination SessionStart hook into ~/.claude/settings.json
// at USER scope — so EVERY `claude` invocation (a direct run in any repo, and
// the orchestrator session) primes with the repo's beads workflow context with
// no per-project setup.
//
// Owner-scoped: the group is tagged `_garrison: "fitting:coord-beads"`, so this
// writer strips ONLY its own group and never collides with other Garrison hook
// writers or hand-authored hooks. Idempotent: re-running strips this owner's
// group before adding a fresh one. Clean removal is wired in Garrison core
// (reconcileCoordTeardown on `up` strips the owner group when deselected) and is
// also available via uninstall-hooks.mjs / `coord uninstall`.
//
// Hook de-duplication (Codex #2 — tightened): `bd setup claude --global` writes
// an UNTAGGED SessionStart group whose single hook command is exactly
// `bd prime --hook-json`. coord-beads is the single manager of that hook, so on
// install it strips precisely that native group shape (untagged, under
// SessionStart only, exactly one hook, command normalized to `bd prime…`) — never
// a hand-authored group that merely mentions bd, and never any other event.
//
// Never clobber (Codex #3): if an existing settings.json cannot be parsed as a
// non-array object, abort WITHOUT writing — leave the live bytes untouched.
//
// Fail-open (Codex #4): the installed command runs a stable, self-timeout-bounded
// wrapper that always exits 0 and emits empty context on any failure — it can
// never error or block a session.
//
// GARRISON_CLAUDE_SETTINGS_PATH overrides the settings path; GARRISON_HOME
// overrides the state root (sandbox/testability).

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const GARRISON_HOME =
  process.env.GARRISON_HOME && process.env.GARRISON_HOME.trim().length > 0
    ? process.env.GARRISON_HOME
    : path.join(HOME, ".garrison");
const SETTINGS_PATH =
  process.env.GARRISON_CLAUDE_SETTINGS_PATH && process.env.GARRISON_CLAUDE_SETTINGS_PATH.trim().length > 0
    ? process.env.GARRISON_CLAUDE_SETTINGS_PATH
    : path.join(HOME, ".claude", "settings.json");
const SNAPSHOT_DIR = path.join(GARRISON_HOME, "snapshots");
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, "claude-settings.before-coord-beads.json");
const BIN_DIR = path.join(GARRISON_HOME, "bin");
const WRAPPER_DST = path.join(BIN_DIR, "coord-beads-prime.sh");
const WRAPPER_SRC = path.join(__dirname, "prime-hook.sh");

const OWNER = "fitting:coord-beads";
const EVENT = "SessionStart";
// The hook calls the STABLE wrapper (survives apm reinstall); guarded + fail-open.
const HOOK_COMMAND = `[ -x ${WRAPPER_DST} ] && ${WRAPPER_DST} || true`;

// Parse settings, distinguishing "absent" (ok → {}) from "present but corrupt"
// (must abort — never clobber).
function parseExistingOrThrow(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`refusing to write: existing settings.json is not valid JSON (${e.message}); leaving it untouched`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("refusing to write: existing settings.json is not a JSON object; leaving it untouched");
  }
  return parsed;
}

function normalizeCmd(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

// EXACT native `bd setup claude` group shape: no owner tag, exactly one command
// hook whose normalized command is `bd prime` or `bd prime --hook-json`.
function isNativeBdPrimeGroup(g) {
  if (!g || typeof g !== "object" || g._garrison) return false;
  if (!Array.isArray(g.hooks) || g.hooks.length !== 1) return false;
  const h = g.hooks[0];
  if (!h || h.type !== "command") return false;
  const cmd = normalizeCmd(h.command);
  return cmd === "bd prime" || cmd === "bd prime --hook-json";
}

// Strip our own owner group (idempotence) across all events + the untagged
// native bd-prime group under SessionStart ONLY (de-dup). Returns removed count.
function stripGroups(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object") return 0;
  let removed = 0;
  for (const [event, list] of Object.entries(settings.hooks)) {
    if (!Array.isArray(list)) continue;
    const before = list.length;
    settings.hooks[event] = list.filter((g) => {
      if (g && g._garrison === OWNER) return false; // idempotence (any event)
      if (event === EVENT && isNativeBdPrimeGroup(g)) return false; // de-dup, SessionStart only
      return true;
    });
    removed += before - settings.hooks[event].length;
  }
  return removed;
}

async function main() {
  // Install the stable fail-open wrapper.
  await fsp.mkdir(BIN_DIR, { recursive: true });
  await fsp.copyFile(WRAPPER_SRC, WRAPPER_DST);
  await fsp.chmod(WRAPPER_DST, 0o755);

  await fsp.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fsp.mkdir(SNAPSHOT_DIR, { recursive: true });

  const existedBefore = fs.existsSync(SETTINGS_PATH);
  const originalText = existedBefore ? await fsp.readFile(SETTINGS_PATH, "utf8") : "";

  // Abort BEFORE any write if the live file is corrupt (never clobber).
  const settings = existedBefore ? parseExistingOrThrow(originalText) : {};

  if (existedBefore && !fs.existsSync(SNAPSHOT_PATH)) {
    await fsp.writeFile(SNAPSHOT_PATH, originalText);
    console.log(`[coord-beads] snapshot saved to ${SNAPSHOT_PATH}`);
  }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  const removed = stripGroups(settings);
  if (removed) console.log(`[coord-beads] removed ${removed} stale coord-beads / native bd-prime group(s)`);

  if (!Array.isArray(settings.hooks[EVENT])) settings.hooks[EVENT] = [];
  settings.hooks[EVENT].push({
    _garrison: OWNER,
    matcher: "",
    hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 8 }]
  });

  await fsp.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`[coord-beads] installed ${OWNER} ${EVENT} hook → ${SETTINGS_PATH}`);
  console.log(`[coord-beads] wrapper → ${WRAPPER_DST}`);
}

main().catch((err) => {
  console.error("[coord-beads] install-hooks failed:", err.message);
  process.exit(1);
});
