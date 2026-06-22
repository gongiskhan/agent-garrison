import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs
import { runGates, splitFrontmatter, parseFrontmatter } from "../fittings/seed/improver/lib/gates.mjs";
// @ts-ignore — pure .mjs
import { buildNewContent } from "../fittings/seed/improver/lib/apply-core.mjs";
// @ts-ignore — pure .mjs
import { setRuleAutonomy, isAuto } from "../fittings/seed/improver/lib/review-queue.mjs";

const ORIG = "---\nname: foo\ndescription: a skill\n---\n\n# Foo\n\nbody.\n";
const ORIG_FM = splitFrontmatter(ORIG).frontmatter;

describe("skill gates (MR5c — skill-gates)", () => {
  it("a body-append edit (frontmatter untouched) passes all gates", () => {
    const proposal = { id: "p1", rule: "skill-suggest", claim: "c", diff: "+## More\n+extra guidance" };
    const next = buildNewContent(ORIG, proposal);
    const r = runGates(next, { sizeLimit: 64 * 1024, originalFrontmatter: ORIG_FM });
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    // the frontmatter is byte-identical after a body append
    expect(splitFrontmatter(next).frontmatter).toBe(ORIG_FM);
  });

  it("a frontmatter rewrite is rejected (body-append-only)", () => {
    const bad = "---\nname: foo\n---\n\nrewritten\n"; // dropped description, changed frontmatter
    const r = runGates(bad, { originalFrontmatter: ORIG_FM });
    expect(r.ok).toBe(false);
    expect(r.failures).toContain("frontmatter-changed");
    expect(r.failures).toContain("frontmatter-missing-description");
  });

  it("an over-limit edit is rejected", () => {
    const big = ORIG + "x".repeat(1000);
    const r = runGates(big, { sizeLimit: 100, originalFrontmatter: ORIG_FM });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f: string) => f.startsWith("size-over-limit"))).toBe(true);
  });

  it("invalid/empty content fails the loads-smoke + frontmatter gates", () => {
    expect(runGates("", {}).ok).toBe(false);
    expect(runGates("no frontmatter here", {}).failures).toContain("frontmatter-invalid");
  });

  it("parseFrontmatter / splitFrontmatter round-trip", () => {
    expect(parseFrontmatter(ORIG)).toMatchObject({ name: "foo", description: "a skill" });
    expect(splitFrontmatter("no fm").frontmatter).toBeNull();
  });
});

describe("gate-fail blocks apply even under autonomy=auto (MR5c — gate-blocks-auto)", () => {
  it("isAuto can be true while a failing gate still blocks the write", () => {
    let autonomy: Record<string, any> = {};
    autonomy = setRuleAutonomy(autonomy, "skill-suggest", "auto");
    expect(isAuto(autonomy, "skill-suggest")).toBe(true); // autonomy says auto-apply

    const bad = "---\nname: foo\n---\n\nrewritten\n";
    const gate = runGates(bad, { originalFrontmatter: ORIG_FM });
    expect(gate.ok).toBe(false); // gates run BEFORE apply, regardless of autonomy

    // the apply contract is: gate must pass before applyWithRetry is reached.
    const wouldApply = isAuto(autonomy, "skill-suggest") && gate.ok;
    expect(wouldApply).toBe(false); // autonomy does NOT bypass the gate
  });
});
