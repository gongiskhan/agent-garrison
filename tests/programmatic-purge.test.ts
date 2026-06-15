import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// Guard for the billing ban (BRIEF v2 §1 / slice MR0a-purge).
//
// Effective 2026-06-15, programmatic Claude invocation — `claude -p`/`--print`,
// headless `--output-format stream-json`, and the in-process Agent SDK
// (`@anthropic-ai/*`) — bills against a separate credit pool at full API rates,
// OUTSIDE plan limits. All of it is banned. Every model call must ride the
// interactive TUI via @garrison/claude-pty (see packages/claude-pty).
//
// This test fails if any banned pattern reappears in tracked PRODUCTION source.
// tests/ are tests-of-the-ban (this file names the patterns to ban them) and
// docs/ describe the ban — both are intentionally out of scope here.

const ROOT = path.resolve(__dirname, "..");

// Production source roots only. Installed deps (apm_modules, node_modules) and
// tests/docs are excluded by construction (git ls-files of these dirs).
const TARGET_DIRS = ["src", "packages", "fittings", "scripts"];

const BANNED: Array<{ label: string; re: RegExp }> = [
  { label: "claude --print (headless)", re: /--print\b/ },
  { label: "headless stream-json output", re: /output-format[ "',]+stream-json/ },
  { label: "Agent SDK import", re: /@anthropic-ai\// },
  { label: "direct Anthropic API host", re: /api\.anthropic\.com/ },
];

function trackedSourceFiles(): string[] {
  const out = execSync(`git ls-files ${TARGET_DIRS.join(" ")}`, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => /\.(ts|tsx|mjs|js|cjs)$/.test(f));
}

describe("programmatic-path purge — billing ban guard", () => {
  it("scans a non-empty set of production source files", () => {
    expect(trackedSourceFiles().length).toBeGreaterThan(50);
  });

  it("contains no banned programmatic-invocation patterns in production source", () => {
    const offenders: string[] = [];
    for (const rel of trackedSourceFiles()) {
      const text = readFileSync(path.join(ROOT, rel), "utf8");
      for (const { label, re } of BANNED) {
        if (re.test(text)) offenders.push(`${rel} :: ${label} (${re})`);
      }
    }
    expect(
      offenders,
      `Banned programmatic Claude-invocation patterns found in production source.\n` +
        `Every model call must go through the interactive PTY (@garrison/claude-pty).\n` +
        offenders.join("\n")
    ).toEqual([]);
  });
});
