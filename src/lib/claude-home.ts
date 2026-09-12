import path from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

// The managed config and the user's config have separate identities. The
// launcher selects the Garrison home with GARRISON_CLAUDE_HOME; GARRISON_USER_*
// identifies the user's own runtime config for explicit sharing and backups.
// Every path accepts a sandbox override. The runner checks the boundary before
// materialisation; a symlink must not collapse these two homes into one.

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

export function userClaudeHome(): string {
  return process.env.GARRISON_USER_CLAUDE_HOME?.trim() || path.join(homedir(), ".claude");
}
export function userClaudeJsonPath(): string {
  return process.env.GARRISON_USER_CLAUDE_JSON?.trim() || path.join(homedir(), ".claude.json");
}
export function userCodexHome(): string {
  return process.env.GARRISON_USER_CODEX_HOME?.trim() || path.join(homedir(), ".codex");
}
export function userGeminiHome(): string {
  return process.env.GARRISON_USER_GEMINI_HOME?.trim() || path.join(homedir(), ".gemini");
}
export function garrisonRuntimeHome(runtime: "claude" | "codex" | "gemini"): string {
  if (runtime === "claude" && process.env.GARRISON_CLAUDE_HOME?.trim()) return claudeHome();
  return path.join(garrisonDir(), "runtime-homes", runtime);
}
export function userCompositionDir(): string { return path.join(garrisonDir(), "user-composition"); }
export function userCompositionClaudeLink(): string { return path.join(userCompositionDir(), ".claude"); }
export function userProvenanceLedgerPath(): string { return path.join(userCompositionDir(), "garrison-provenance.json"); }

// Resolve existing ancestors too, so a not-yet-created path under a symlink
// cannot evade the same-home refusal.
export function resolvedHome(home: string): string {
  const absolute = path.resolve(home);
  try { return realpathSync(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(resolvedHome(parent), path.basename(absolute));
  }
}
export function garrisonHomeRefusal(): string {
  return `refusing to run Garrison against your own Claude Code config; the Garrison home is ${path.join(garrisonDir(), "runtime-homes", "claude")}`;
}
export function assertGarrisonHome(): void {
  if (process.env.GARRISON_ALLOW_USER_HOME !== "1" && resolvedHome(claudeHome()) === resolvedHome(userClaudeHome())) {
    throw new Error(garrisonHomeRefusal());
  }
}
