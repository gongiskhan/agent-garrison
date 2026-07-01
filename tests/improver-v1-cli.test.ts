import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The hermetic acceptance gate: a single `improver.mjs run-now` under the env
// seams runs BOTH phases and prints FINDING 1..6 + `IMPROVER-V1 OK` last. It
// mutates only the tmp sandbox (GARRISON_CLAUDE_HOME + IMPROVER_DATA).

const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "fittings", "seed", "improver", "scripts", "improver.mjs");
const FIXTURES = join(__dirname, "fixtures", "improver");
const S1 = "11111111-1111-4111-8111-111111111111";

describe("Improver v1 skills CLI — hermetic acceptance (MR5c)", () => {
  it("prints all six FINDINGs and IMPROVER-V1 OK as the final line", () => {
    const root = mkdtempSync(join(tmpdir(), "improver-v1-"));
    try {
      const claudeHome = join(root, "claude");
      const dataDir = join(root, "data");
      mkdirSync(join(claudeHome, "skills"), { recursive: true });
      mkdirSync(dataDir, { recursive: true });
      cpSync(join(FIXTURES, "skills"), join(claudeHome, "skills"), { recursive: true });

      const out = execFileSync("node", [CLI, "run-now"], {
        encoding: "utf8",
        env: {
          ...process.env,
          IMPROVER_PROJECTS_DIR: join(FIXTURES, "projects"),
          GARRISON_CLAUDE_HOME: claudeHome,
          IMPROVER_LOCK: join(FIXTURES, "apm.lock.yaml"),
          IMPROVER_PINNED: "pinned-helper",
          IMPROVER_MODEL_FIXTURE: join(FIXTURES, "model-reply.json"),
          IMPROVER_DATA: dataDir,
          IMPROVER_NOW: "2026-06-17T12:00:00Z",
          IMPROVER_STALE_DAYS: "30",
          IMPROVER_ARCHIVE_DAYS: "120",
        },
      });

      const lines = out.trimEnd().split("\n");
      expect(out).toContain("FINDING 1 — maintenance ran deterministically: evaluated=2 transitioned=1");
      expect(out).toMatch(/FINDING 2 —.*pinned-helper untouched/);
      expect(out).toMatch(/FINDING 3 —.*evidence\.sessionId in telemetry=true/);
      expect(out).toContain(`"sessionId": "${S1}"`); // the cited, real sessionId
      expect(out).toMatch(/FINDING 4 —.*snapshot .*created before apply.*matches=true/);
      expect(out).toContain("GATE FAIL -> not applied"); // FINDING 5
      expect(out).toContain("@garrison/claude-pty#oneShotTurn"); // FINDING 6
      expect(lines[lines.length - 1]).toBe("IMPROVER-V1 OK");

      // side effects landed in the sandbox data dir, not anything real
      expect(existsSync(join(dataDir, "maintenance.json"))).toBe(true);
      expect(existsSync(join(dataDir, "skill-telemetry.json"))).toBe(true);

      // the ecosystem-update + reapply-sweep phases ran (before the
      // IMPROVER_PROJECTS_DIR branch) on every invocation - no composition dir
      // is set here, so ecosystem-update logs itself skipped rather than
      // shelling out to a real `apm`, and the sweep finds an empty queue.
      const ecosystemLog = JSON.parse(readFileSync(join(dataDir, "ecosystem-update-log.json"), "utf8"));
      expect(ecosystemLog).toHaveLength(1);
      expect(ecosystemLog[0].skipped).toMatch(/no apm\.yml/);
      const sweepLog = JSON.parse(readFileSync(join(dataDir, "reapply-sweep-log.json"), "utf8"));
      expect(sweepLog).toHaveLength(1);
      expect(sweepLog[0].checked).toBe(0);
      const queue = JSON.parse(readFileSync(join(dataDir, "review-queue.json"), "utf8"));
      expect(queue.some((p: any) => p.rule === "skill-suggest")).toBe(true);

      // the snapshot rollback left the live skill byte-identical to the fixture
      const liveSkill = readFileSync(join(claudeHome, "skills", "garrison-helper", "SKILL.md"), "utf8");
      const fixtureSkill = readFileSync(join(FIXTURES, "skills", "garrison-helper", "SKILL.md"), "utf8");
      expect(liveSkill).toBe(fixtureSkill);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
