import path from "node:path";
import { homedir } from "node:os";

// Resolves the Claude Code installation dir and Garrison's own state dir.
//
// Both honour an env override so the build's exploration / e2e / walkthrough
// runs can be pointed at a seeded SANDBOX instead of mutating the user's live
// ~/.claude. Default (no env) is the real path — production behaviour.
//
//   GARRISON_CLAUDE_HOME  -> the Claude Code install root  (default ~/.claude)
//   GARRISON_HOME         -> Garrison's state root          (default ~/.garrison)

export function claudeHome(): string {
  const override = process.env.GARRISON_CLAUDE_HOME?.trim();
  return override && override.length > 0 ? override : path.join(homedir(), ".claude");
}

export function garrisonDir(): string {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(homedir(), ".garrison");
}
