import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// FINDING 6 (static half): the skills model pass rides the interactive PTY
// (@garrison/claude-pty#oneShotTurn), never the Agent SDK. This asserts the
// module is free of the banned programmatic-invocation tokens and uses the
// dynamic-import PTY path — complementing tests/programmatic-purge.test.ts, which
// scans the whole fittings/ tree (so this file is covered there once tracked).

const ROOT = path.resolve(__dirname, "..");
const REL = "fittings/seed/improver/lib/skill-proposal.mjs";
const SRC = readFileSync(path.join(ROOT, REL), "utf8");

const BANNED = [/@anthropic-ai\//, /--print\b/, /output-format[ "',]+stream-json/, /api\.anthropic\.com/];

describe("improver skills pass is PTY-not-SDK (MR5c — pty-path)", () => {
  it("contains no banned programmatic-invocation tokens", () => {
    for (const re of BANNED) expect(SRC, `banned token ${re} present`).not.toMatch(re);
  });

  it("uses the dynamic import of @garrison/claude-pty and oneShotTurn", () => {
    expect(SRC).toMatch(/import\(\s*["']@garrison\/claude-pty["']\s*\)/);
    expect(SRC).toContain("oneShotTurn");
    expect(SRC).toContain('INVOCATION_PATH = "@garrison/claude-pty#oneShotTurn"');
  });

  it("is tracked under a purge target dir (fittings/), so the purge guard covers it", () => {
    const tracked = execSync(`git ls-files ${REL}`, { cwd: ROOT, encoding: "utf8" }).trim();
    expect(tracked).toBe(REL);
  });
});
