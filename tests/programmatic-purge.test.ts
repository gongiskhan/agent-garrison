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

// The `stream-json` pattern is the one engine-AGNOSTIC rule here: it matches the
// string wherever it appears, but the policy it enforces is about CLAUDE. Cursor
// has no interactive API at all - `cursor-agent -p --output-format stream-json`
// IS its non-interactive interface, and it is what lets a remote machine be an
// ordinary runtime target instead of a screen we scrape (the exec lane in
// remote-shell-runtime; cursor-runtime already ships the buffered `json` form of
// the same call).
//
// So the exemption is per FILE and SELF-CHECKING: a listed file keeps its pass
// only while it is still a cursor-agent caller. Claude's own headless flags stay
// banned everywhere, this file included - the other two patterns are not relaxed.
const CURSOR_HEADLESS_FILES = new Set([
  "fittings/seed/remote-shell-runtime/lib/sessions.mjs",
]);

const BANNED: Array<{ label: string; re: RegExp }> = [
  // `\b` alone also matched an unrelated flag whose name merely STARTS with
  // print (`--print-only` in a spike script), which is not headless mode and
  // not what this guard is about. Claude's headless flag is exactly `--print`,
  // so require the match to end there.
  { label: "claude --print (headless)", re: /--print(?![-\w])/ },
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
  it("exempts only files that really are cursor-agent callers", () => {
    // The exemption exists for an engine with no interactive API. If one of
    // these files stops calling cursor-agent, it stops being exempt - otherwise
    // the entry silently becomes a hole for anything at all.
    for (const rel of CURSOR_HEADLESS_FILES) {
      const full = path.join(ROOT, rel);
      expect(existsSync(full), `${rel} is listed but missing`).toBe(true);
      expect(readFileSync(full, "utf8"), `${rel} no longer calls cursor-agent`).toMatch(/cursor-agent/);
      // Claude's own headless flags stay banned in the exempt file too.
      expect(readFileSync(full, "utf8")).not.toMatch(/\bclaude['"]?,?\s+['"]?-p\b/);
    }
  });

  it("scans a non-empty set of production source files", () => {
    expect(trackedSourceFiles().length).toBeGreaterThan(50);
  });

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
      const cursorExempt = CURSOR_HEADLESS_FILES.has(rel) && /cursor-agent/.test(code);
      for (const { label, re } of BANNED) {
        if (!re.test(code)) continue;
        if (cursorExempt && label === "headless stream-json output") continue;
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
