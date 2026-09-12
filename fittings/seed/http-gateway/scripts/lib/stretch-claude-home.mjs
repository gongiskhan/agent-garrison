// stretch-claude-home.mjs — a stretch is not the user's Claude Code session.
//
// Stretches spawn with CLAUDE_CONFIG_DIR unset, so the CLI reads the user's
// real ~/.claude and injects three system-reminders into the first user message
// of EVERY stretch: the agent-type list, the personal skills list, and the
// project memory index. Measured 2026-08-29: 4,546 tokens on haiku, ~6,300 on
// sonnet, about a quarter of what is left of the boot prefix.
//
// Three reasons to stop, in ascending order of importance:
//   1. Tokens. It is the largest remaining item Garrison can do anything about.
//   2. Cache stability. The memory index changes whenever the user's personal
//      memory changes, which silently forks the byte-stable prefix that
//      cross-stretch cache sharing depends on. A prefix that drifts with an
//      unrelated file is not a prefix.
//   3. Containment. Personal memory is currently shipped into every stretch,
//      including stretches that run on a second provider.
//
// What the Garrison-owned directory carries is decided EXPLICITLY, not by
// copying: credentials, because a stretch must authenticate, and the CLI's
// sibling state file, because a fresh one makes the CLI re-run onboarding and
// re-ask about trusting the directory. Nothing else - no CLAUDE.md, no skills,
// no agents, no projects, no settings, no hooks. A stretch that needs one of
// those should be given it deliberately.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** The user's real config dir - what a stretch would read if left alone. */
export function realClaudeConfigDir(env = process.env) {
  return String(env.CLAUDE_CONFIG_DIR || env.GARRISON_CLAUDE_HOME || path.join(os.homedir(), ".claude"));
}

// Credentials are SYMLINKED, never copied: the CLI refreshes an OAuth token in
// place, and a copy would go stale and start failing turns hours later in a way
// that looks like a model problem.
const LINKED = [".credentials.json"];

/**
 * Materialise the stretch config dir and return its path, or null when it
 * cannot be made safely (in which case the caller leaves CLAUDE_CONFIG_DIR
 * alone and stretches keep working exactly as before).
 */
export function ensureStretchClaudeHome({ garrisonHome, env = process.env, log = null } = {}) {
  const home = garrisonHome || env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  const dir = path.join(home, "stretch-claude");
  const real = realClaudeConfigDir(env);
  try {
    fs.mkdirSync(dir, { recursive: true });

    for (const name of LINKED) {
      const source = path.join(real, name);
      const link = path.join(dir, name);
      if (!fs.existsSync(source)) continue;
      let current = null;
      try { current = fs.readlinkSync(link); } catch { /* absent or a real file */ }
      if (current === source) continue;
      try { fs.rmSync(link, { force: true }); } catch { /* nothing there */ }
      fs.symlinkSync(source, link);
    }
    // No credentials reachable means every stretch would fail to authenticate.
    // Refusing here keeps the existing behaviour instead of breaking the run.
    if (!fs.existsSync(path.join(dir, ".credentials.json"))) {
      log?.({ kind: "stretch-claude-home-skipped", reason: "no credentials to link", real });
      return null;
    }

    // The CLI keeps its state file NEXT TO the config dir, not inside it.
    // Seed it once from the user's so a stretch does not hit onboarding or a
    // directory-trust prompt; after that it is Garrison's own file and diverges
    // freely.
    const sibling = `${dir}.json`;
    if (!fs.existsSync(sibling)) {
      const userSibling = `${real}.json`;
      let seed = "{}\n";
      if (fs.existsSync(userSibling)) {
        try {
          const raw = JSON.parse(fs.readFileSync(userSibling, "utf8"));
          // Only the onboarding/trust flags travel. Project history, tips,
          // prompt history and anything else personal stays behind.
          const keep = [
            "hasCompletedOnboarding", "installMethod", "autoUpdates", "userID",
            "firstStartTime", "hasTrustDialogAccepted", "bypassPermissionsModeAccepted",
            "theme", "numStartups",
          ];
          seed = `${JSON.stringify(Object.fromEntries(keep.filter((k) => k in raw).map((k) => [k, raw[k]])), null, 2)}\n`;
        } catch { /* an unreadable user file just means an empty seed */ }
      }
      fs.writeFileSync(sibling, seed, { mode: 0o600 });
    }
    log?.({ kind: "stretch-claude-home", dir, linked: LINKED });
    return dir;
  } catch (err) {
    log?.({ kind: "stretch-claude-home-failed", error: String(err?.message ?? err) });
    return null;
  }
}
