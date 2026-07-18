#!/usr/bin/env node
// Idempotent installer. Symlinks the bundled SKILL.md into
// ~/.claude/skills/garrison-browser/SKILL.md and the CLI into
// ~/.garrison/bin/garrison-browser. Safe to re-run; replaces stale links.

import { existsSync, lstatSync, mkdirSync, readlinkSync, unlinkSync, symlinkSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SKILL_SRC = path.resolve(HERE, "..", ".apm", "skills", "garrison-browser", "SKILL.md");
const CLI_SRC = path.resolve(HERE, "cli.mjs");

const HOME = os.homedir();
const CLAUDE_HOME = process.env.GARRISON_CLAUDE_HOME || path.join(HOME, ".claude");
const GARRISON_HOME = process.env.GARRISON_HOME || path.join(HOME, ".garrison");
const SKILL_DIR = path.join(CLAUDE_HOME, "skills", "garrison-browser");
const SKILL_DST = path.join(SKILL_DIR, "SKILL.md");
const BIN_DIR = path.join(GARRISON_HOME, "bin");
const BIN_DST = path.join(BIN_DIR, "garrison-browser");

function lstatExists(p) { try { lstatSync(p); return true; } catch { return false; } }

function installSymlink(src, dst) {
  if (!existsSync(src)) {
    console.error(`[install-skill] source missing: ${src}`);
    process.exit(2);
  }
  mkdirSync(path.dirname(dst), { recursive: true });
  if (lstatExists(dst)) {
    try {
      const st = lstatSync(dst);
      if (st.isSymbolicLink()) {
        const cur = readlinkSync(dst);
        if (cur === src) return; // already correct
        unlinkSync(dst);
      } else {
        // A regular file lives here — back off; don't clobber the user.
        console.warn(`[install-skill] ${dst} is not a symlink — leaving it alone`);
        return;
      }
    } catch (err) {
      console.warn(`[install-skill] could not inspect ${dst}: ${err.message}`);
      return;
    }
  }
  symlinkSync(src, dst);
}

try {
  installSymlink(SKILL_SRC, SKILL_DST);
  installSymlink(CLI_SRC, BIN_DST);
  try { chmodSync(CLI_SRC, 0o755); } catch { /* ignore */ }
  console.log(`[install-skill] ${SKILL_DST}`);
  console.log(`[install-skill] ${BIN_DST}`);
  if (!process.env.PATH?.split(":").includes(BIN_DIR)) {
    console.log(`[install-skill] note: add ${BIN_DIR} to PATH to call \`garrison-browser\` directly`);
  }
} catch (err) {
  console.error(`[install-skill] failed: ${err.message}`);
  process.exit(1);
}
