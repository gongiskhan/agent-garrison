import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { planMaintenance, daysSince } from "../fittings/seed/improver/lib/maintenance-core.mjs";
// @ts-ignore — pure .mjs
import { makeClassifier, skillNameFromDeployedPath, readLock } from "../fittings/seed/improver/lib/provenance.mjs";
// @ts-ignore — pure .mjs
import { archiveSkill, unarchiveSkill } from "../fittings/seed/improver/lib/archive.mjs";

const NOW = "2026-06-17T12:00:00Z";

function telemetry(map: Record<string, string | null>) {
  const bySkill: Record<string, any> = {};
  for (const [name, lastUsedAt] of Object.entries(map)) {
    bySkill[name] = { useCount: 1, lastUsedAt, sessionIds: new Set(["s"]), lastCitation: { sessionId: "s" } };
  }
  return { bySkill };
}

describe("provenance gate (MR5c — provenance-gate)", () => {
  it("classifies owned/loose/pinned and eligibility = owned && !pinned", () => {
    const classify = makeClassifier(new Set(["a", "b"]), new Set(["b"]));
    expect(classify("a")).toEqual({ owned: true, pinned: false, eligible: true });
    expect(classify("b")).toEqual({ owned: true, pinned: true, eligible: false });
    expect(classify("c")).toEqual({ owned: false, pinned: false, eligible: false });
  });

  it("derives skill names from real lock deployed_files paths (dir or /-prefix)", () => {
    expect(skillNameFromDeployedPath(".claude/skills/artifact-store")).toBe("artifact-store");
    expect(skillNameFromDeployedPath("skills/foo/SKILL.md")).toBe("foo");
    expect(skillNameFromDeployedPath(".claude/rules/http-gateway.md")).toBeNull();
  });

  it("a missing/unparseable lock fails safe to an empty owned set", () => {
    expect(readLock("/no/such/lock.yaml").size).toBe(0);
  });

  it("reads the fixture lock as the owned set", () => {
    const owned = readLock(join(__dirname, "fixtures", "improver", "apm.lock.yaml"));
    expect(owned.has("garrison-helper")).toBe(true);
    expect(owned.has("legacy-helper")).toBe(true);
    expect(owned.has("pinned-helper")).toBe(true);
    expect(owned.has("human-notes")).toBe(false); // loose
  });
});

describe("maintenance planner (MR5c — maintenance-deterministic)", () => {
  const classify = makeClassifier(new Set(["active", "stale", "old"]), new Set(["pinnedOwned"]));

  it("marks stale/archive by age and skips ineligible skills untouched", () => {
    const tel = telemetry({
      active: "2026-06-17T00:00:00Z", // ~0.5d
      stale: "2026-05-01T00:00:00Z", // ~47d
      old: "2026-01-01T00:00:00Z", // ~167d
    });
    const plan = planMaintenance({
      skills: ["active", "stale", "old", "pinnedOwned", "loose"],
      telemetry: tel,
      classify: makeClassifier(new Set(["active", "stale", "old", "pinnedOwned"]), new Set(["pinnedOwned"])),
      now: NOW,
      staleDays: 30,
      archiveDays: 90,
    });
    expect(plan.evaluated).toHaveLength(3); // active, stale, old (eligible)
    const byName = Object.fromEntries(plan.evaluated.map((e: any) => [e.name, e.state]));
    expect(byName).toEqual({ active: "active", stale: "stale", old: "archive" });
    expect(plan.transitions.map((t: any) => t.name).sort()).toEqual(["old", "stale"]);
    expect(plan.skipped.find((s: any) => s.name === "pinnedOwned")?.reason).toBe("pinned");
    expect(plan.skipped.find((s: any) => s.name === "loose")?.reason).toBe("loose");
  });

  it("does not re-emit a transition that already matches prior state", () => {
    const tel = telemetry({ stale: "2026-05-01T00:00:00Z" });
    const plan = planMaintenance({
      skills: ["stale"],
      telemetry: tel,
      classify,
      now: NOW,
      staleDays: 30,
      archiveDays: 90,
      priorState: { stale: "stale" },
    });
    expect(plan.transitions).toHaveLength(0);
    expect(plan.evaluated[0].state).toBe("stale");
  });

  it("daysSince treats never-used as Infinity", () => {
    expect(daysSince(null, NOW)).toBe(Infinity);
    expect(daysSince("2026-06-16T12:00:00Z", NOW)).toBeCloseTo(1, 1);
  });
});

describe("archive reversibility (MR5c — archive-reversible)", () => {
  it("archive then unarchive round-trips a skill dir byte-for-byte", async () => {
    const root = mkdtempSync(join(tmpdir(), "improver-arch-"));
    try {
      const claudeHome = join(root, "claude");
      const dataDir = join(root, "data");
      const skillDir = join(claudeHome, "skills", "tmp-skill");
      mkdirSync(skillDir, { recursive: true });
      const body = "---\nname: tmp-skill\ndescription: x\n---\nbody\n";
      writeFileSync(join(skillDir, "SKILL.md"), body, "utf8");

      const a = await archiveSkill("tmp-skill", { claudeHome, dataDir, now: NOW });
      expect(a.ok).toBe(true);
      expect(existsSync(skillDir)).toBe(false); // moved off-disk
      expect(existsSync(join(dataDir, "archived", "tmp-skill", "SKILL.md"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dataDir, "archived.json"), "utf8"))["tmp-skill"]).toBeTruthy();

      const u = await unarchiveSkill("tmp-skill", { claudeHome, dataDir });
      expect(u.ok).toBe(true);
      expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe(body); // restored
      // the off-disk copy is never destroyed
      expect(existsSync(join(dataDir, "archived", "tmp-skill", "SKILL.md"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dataDir, "archived.json"), "utf8"))["tmp-skill"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
