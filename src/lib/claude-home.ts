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
