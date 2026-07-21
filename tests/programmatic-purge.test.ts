import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Guard for the headless-mode exclusion (D29 reframe of the former billing ban).
//
// The June-15 billing split was PAUSED (D29), so the PTY-everywhere rule is
// retired: the in-process Agent SDK (`@anthropic-ai/*`) and the Anthropic endpoint
// are now FIRST-CLASS — the agent-sdk runtime routes to Anthropic/DeepSeek/GLM/
// Ollama with no fence. What remains banned is `claude -p`/`--print` headless mode
// (incl. its `--output-format stream-json`), excluded as a CAPABILITY choice:
// headless mode is too limited for Garrison's interactive + agentic model. This is
// NOT a billing rule — it is a capability policy.
//
// This test fails if a banned headless pattern reappears in tracked PRODUCTION
// source. tests/ are tests-of-the-ban (this file names the patterns to ban them)
// and docs/ describe the policy — both are intentionally out of scope here.

const ROOT = path.resolve(__dirname, "..");

// Production source roots only. Installed deps (apm_modules, node_modules) and
// tests/docs are excluded by construction (git ls-files of these dirs).
const TARGET_DIRS = ["src", "packages", "fittings", "scripts"];

const BANNED: Array<{ label: string; re: RegExp }> = [
  { label: "claude --print (headless)", re: /--print\b/ },
  { label: "claude -p (headless short flag)", re: /\bclaude['"]?,?\s+['"]?-p\b/ },
  { label: "headless stream-json output", re: /output-format[ "',]+stream-json/ },
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
    .filter((f) => /\.(ts|tsx|mjs|js|cjs)$/.test(f))
    // A tracked file may be deleted-but-not-yet-committed (e.g. a swept module) —
    // it has no content to scan, so skip it.
    .filter((f) => existsSync(path.join(ROOT, f)));
}

describe("headless-mode exclusion guard (claude -p stays banned as a capability choice)", () => {
  it("scans a non-empty set of production source files", () => {
    expect(trackedSourceFiles().length).toBeGreaterThan(50);
  });

  // The ONE sanctioned exception: outpost dispatch pipes a prompt into
  // `claude -p` on a REMOTE outpost host, where the exec API offers no PTY.
  // The local capability exclusion stands; this file may not grow more usages.
  const REMOTE_DISPATCH_EXCEPTION = "fittings/seed/kanban-loop/lib/outpost-dispatch.mjs";

  it("contains no banned headless-invocation patterns in production source", () => {
    const offenders: string[] = [];
    for (const rel of trackedSourceFiles()) {
      const text = readFileSync(path.join(ROOT, rel), "utf8");
      // Comments may DISCUSS the exclusion; only executable lines count.
      const code = text
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return !(t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*"));
        })
        .join("\n");
      for (const { label, re } of BANNED) {
        if (!re.test(code)) continue;
        if (rel === REMOTE_DISPATCH_EXCEPTION && label.includes("short flag")) continue;
        offenders.push(`${rel} :: ${label} (${re})`);
      }
    }
    expect(
      offenders,
      `Banned headless Claude-invocation patterns found in production source.\n` +
        `claude -p / --output-format stream-json is excluded as a capability choice ` +
        `(headless mode is too limited); every model call rides the interactive PTY ` +
        `(@garrison/claude-pty) or the in-process Agent SDK.\n` +
        offenders.join("\n")
    ).toEqual([]);
  });
});
