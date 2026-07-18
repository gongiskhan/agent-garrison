// Path helpers for the Claude Code on-disk layout. Ported from
// ekoa-core/src/paths/resolve.ts, narrowed to what the PTY substrate needs.
//
// Claude Code writes a JSONL transcript per session under
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// where <encoded-cwd> replaces BOTH "/" and "." with "-". Both are
// replaced because Claude Code itself does so (verified against the
// on-disk dir names under ~/.claude/projects).
//
// The trust flag (`projects.<cwd>.hasTrustDialogAccepted`) lives in the
// global config (~/.claude.json).
//
// Two env overrides exist purely so the test suite can point the substrate
// at a sandbox HOME without touching the live install:
//   GARRISON_CLAUDE_PROJECTS_DIR  → overrides ~/.claude/projects
//   GARRISON_CLAUDE_CONFIG_PATH   → overrides ~/.claude.json

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Root directory where Claude Code stores per-session JSONL transcripts. */
export function claudeProjectsDir() {
  const override = process.env.GARRISON_CLAUDE_PROJECTS_DIR?.trim();
  if (override) return override;
  const claudeHome = process.env.GARRISON_CLAUDE_HOME?.trim();
  if (claudeHome) return join(claudeHome, "projects");
  return join(homedir(), ".claude", "projects");
}

/** The transcript directory Claude Code uses for sessions spawned at `cwd`. */
export function claudeProjectDirForCwd(cwd) {
  return join(claudeProjectsDir(), cwd.replace(/[/.]/g, "-"));
}

/** Path to Claude Code's global config file (`~/.claude.json`). */
export function claudeGlobalConfigPath() {
  const override = process.env.GARRISON_CLAUDE_CONFIG_PATH?.trim();
  if (override) return override;
  const claudeHome = process.env.GARRISON_CLAUDE_HOME?.trim();
  if (claudeHome) {
    return basename(claudeHome) === ".claude"
      ? join(dirname(claudeHome), ".claude.json")
      : join(claudeHome, ".claude.json");
  }
  return join(homedir(), ".claude.json");
}
