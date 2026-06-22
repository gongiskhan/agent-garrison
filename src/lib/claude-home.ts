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

// Claude Code's user config file `~/.claude.json` — a SIBLING of ~/.claude (not
// inside it). This is where Claude Code actually reads user-scope `mcpServers`
// from (the in-`~/.claude` `mcp.json` is a legacy/empty Garrison-era file). The
// HV wave repoints the MCP surface here. Honors a dedicated override so the
// sandbox can seed it without touching the live file; otherwise it is the
// sibling of claudeHome() so GARRISON_CLAUDE_HOME=<tmp>/.claude resolves to
// <tmp>/.claude.json.
export function claudeJsonPath(home: string = claudeHome()): string {
  const override = process.env.GARRISON_CLAUDE_JSON?.trim();
  if (override && override.length > 0) return override;
  // Production: ~/.claude → its SIBLING ~/.claude.json. For a sandbox whose home
  // is NOT named `.claude` (e.g. a bare mkdtemp dir), keep the file INSIDE the
  // home dir so it can never escape to a shared parent — GARRISON_CLAUDE_HOME
  // stays fully isolated, and a test that wants the real layout names its home
  // `<root>/.claude` (or sets GARRISON_CLAUDE_JSON explicitly).
  if (path.basename(home) === ".claude") return path.join(path.dirname(home), ".claude.json");
  return path.join(home, ".claude.json");
}

export function garrisonDir(): string {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(homedir(), ".garrison");
}

// The Garrison-owned APM project that drives the REAL ~/.claude install.
//
// APM is project-scoped: `apm install` deploys into `<cwd>/.claude/`. We make
// `<cwd>` this dir and symlink its `.claude` to claudeHome(), so `apm install`
// writes THROUGH the link into the real ~/.claude while apm.yml + apm_modules/
// stay confined here (never polluting $HOME). Verified symlink write-through.
export function globalCompositionDir(): string {
  return path.join(garrisonDir(), "global-composition");
}

// The symlink (`<global-composition>/.claude` -> claudeHome()) APM deploys through.
export function globalCompositionClaudeLink(): string {
  return path.join(globalCompositionDir(), ".claude");
}

// Store for fittings reconcile captures from loose primitives — minimal APM
// packages that `promote` references as deps. Distinct from the in-repo
// fittings/seed catalog (operative composition) and from the parked store.
export function capturedFittingsDir(): string {
  return path.join(garrisonDir(), "fittings");
}

// Off-disk store for parked primitives (owned -> parked): packaged fittings the
// user removed from the composition but did not delete. Out of Quarters; shown
// in the Seed view. Honors GARRISON_HOME so the e2e sandbox stays isolated.
export function parkedStoreDir(): string {
  return path.join(garrisonDir(), "parked");
}

// Provenance ledger: carries what apm.lock structurally cannot (hook/MCP
// ownership, per-primitive lastWrittenHash for echo suppression).
export function provenanceLedgerPath(): string {
  return path.join(globalCompositionDir(), "garrison-provenance.json");
}
