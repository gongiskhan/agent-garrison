import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs
import { proposeSkillImprovements, tolerantJSON, INVOCATION_PATH } from "../fittings/seed/improver/lib/skill-proposal.mjs";

const TEL = {
  bySkill: {
    "garrison-helper": {
      useCount: 3,
      lastUsedAt: "2026-06-17T00:00:00Z",
      sessionIds: new Set(["S1"]),
      lastCitation: { sessionId: "S1", timestamp: "2026-06-17T00:00:00Z", argsExcerpt: "compose", error: true },
    },
    other: {
      useCount: 1,
      lastUsedAt: "2026-06-10T00:00:00Z",
      sessionIds: new Set(["S2"]),
      lastCitation: { sessionId: "S2", timestamp: "2026-06-10T00:00:00Z", argsExcerpt: "x" },
    },
  },
};

function stub(reply: string) {
  return async () => ({ reply, sessionId: "model-sess" });
}

const REPLY = JSON.stringify({
  proposals: [
    { skill: "garrison-helper", sessionId: "S1", signal: "adjacent-error", claim: "fix it", append: "## Tips\nbe careful" },
    { skill: "other", sessionId: "FAKE", claim: "hallucinated", append: "nope" }, // fabricated sessionId
    { skill: "ghost", sessionId: "S1", claim: "not eligible", append: "drop" }, // not eligible
    { skill: "other", sessionId: "S2", claim: "valid second", append: "more" }, // valid
  ],
});

describe("skill-proposal: PTY pass (MR5c — skill-proposal)", () => {
  it("builds canonical proposals from valid items only", async () => {
    const r = await proposeSkillImprovements({
      eligibleSkills: ["garrison-helper", "other"],
      telemetry: TEL,
      cap: 8,
      runTurn: stub(REPLY),
      now: "2026-06-17T12:00:00Z",
    });
    expect(r.invocationPath).toBe(INVOCATION_PATH);
    expect(r.proposals.map((p: any) => p.targetFile)).toEqual([
      "skills/garrison-helper/SKILL.md",
      "skills/other/SKILL.md",
    ]);
    const p = r.proposals[0];
    expect(p.rule).toBe("skill-suggest");
    expect(p.targetClass).toBe("skill");
    expect(p.evidence.sessionId).toBe("S1");
    expect(p.diff.startsWith("+## Tips")).toBe(true);
    expect(p.gates).toContain("frontmatter-identical");
    expect(p.decision).toBeTruthy();
    expect(p.id).toMatch(/^skill-suggest-garrison-helper-[0-9a-f]{8}$/);
  });

  it("drops a proposal whose cited sessionId is not in telemetry (honest evidence)", async () => {
    const r = await proposeSkillImprovements({ eligibleSkills: ["garrison-helper", "other"], telemetry: TEL, runTurn: stub(REPLY) });
    expect(r.dropped.some((d: any) => d.reason === "fabricated-sessionId" && d.skill === "other")).toBe(true);
  });

  it("drops a proposal for a non-eligible skill", async () => {
    const r = await proposeSkillImprovements({ eligibleSkills: ["garrison-helper", "other"], telemetry: TEL, runTurn: stub(REPLY) });
    expect(r.dropped.some((d: any) => d.reason === "not-eligible" && d.skill === "ghost")).toBe(true);
  });

  it("enforces the cap by slice (never trusts the model's count)", async () => {
    const r = await proposeSkillImprovements({ eligibleSkills: ["garrison-helper", "other"], telemetry: TEL, cap: 1, runTurn: stub(REPLY) });
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0].targetFile).toBe("skills/garrison-helper/SKILL.md");
  });

  it("dedupes by skill (one proposal per skill per run)", async () => {
    const dupeReply = JSON.stringify({
      proposals: [
        { skill: "garrison-helper", sessionId: "S1", claim: "first", append: "a" },
        { skill: "garrison-helper", sessionId: "S1", claim: "second", append: "b" },
      ],
    });
    const r = await proposeSkillImprovements({ eligibleSkills: ["garrison-helper"], telemetry: TEL, runTurn: stub(dupeReply) });
    expect(r.proposals).toHaveLength(1);
    expect(r.dropped.some((d: any) => d.reason === "dupe-skill")).toBe(true);
  });

  it("no eligible skills → no model call, no proposals", async () => {
    let called = false;
    const r = await proposeSkillImprovements({ eligibleSkills: [], telemetry: TEL, runTurn: async () => ((called = true), { reply: "{}", sessionId: null }) });
    expect(called).toBe(false);
    expect(r.proposals).toEqual([]);
  });

  it("tolerantJSON extracts JSON embedded in prose", () => {
    expect(tolerantJSON('here you go: {"proposals":[]} thanks')).toEqual({ proposals: [] });
    expect(tolerantJSON("not json at all")).toBeNull();
  });
});
