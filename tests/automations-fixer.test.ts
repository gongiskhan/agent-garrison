import { describe, expect, it } from "vitest";
import { REHEARSAL_BUDGET, detectHumanActionable, applyPatch, validatePatch, proposePatch } from "../fittings/seed/automations/lib/fixer.mjs";

// G1s — the self-healing fixer (ported from ekoa rehearsal.ts).

describe("fixer fast-path (G1s)", () => {
  it("detects CAPTCHA / MFA / payment, ignores ordinary failures", () => {
    expect(detectHumanActionable("The page shows a Google reCAPTCHA verification")?.reasoning).toMatch(/CAPTCHA/i);
    expect(detectHumanActionable("enter the 6-digit code from your authenticator app")?.reasoning).toMatch(/multi-factor/i);
    expect(detectHumanActionable("confirm payment via 3D Secure")?.reasoning).toMatch(/payment/i);
    expect(detectHumanActionable("element not found: button[name=Export]")).toBeNull();
    expect(detectHumanActionable("")).toBeNull();
  });

  it("budget caps are the ekoa values", () => {
    expect(REHEARSAL_BUDGET.maxFixerCalls).toBe(25);
    expect(REHEARSAL_BUDGET.maxPatchesPerIndex).toBe(5);
  });
});

describe("applyPatch (G1s)", () => {
  const steps = () => [{ id: "s1", type: "browser" }, { id: "s2", type: "verify" }];
  it("insert_before puts the new step at the index (original runs next)", () => {
    const out = applyPatch(steps(), 0, { kind: "insert_before", newStep: { id: "fix1", type: "browser", description: "dismiss banner" } });
    expect(out.map((s) => s.id)).toEqual(["fix1", "s1", "s2"]);
  });
  it("replace_current swaps the failing step", () => {
    const out = applyPatch(steps(), 0, { kind: "replace_current", newStep: { id: "s1b", type: "browser" } });
    expect(out.map((s) => s.id)).toEqual(["s1b", "s2"]);
  });
  it("skip_current drops the step", () => {
    expect(applyPatch(steps(), 0, { kind: "skip_current" }).map((s) => s.id)).toEqual(["s2"]);
  });
  it("abort / pause_for_user leave the plan unchanged", () => {
    expect(applyPatch(steps(), 0, { kind: "abort" }).map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(applyPatch(steps(), 0, { kind: "pause_for_user" }).map((s) => s.id)).toEqual(["s1", "s2"]);
  });
  it("assigns an id to an inserted step that lacks one", () => {
    const out = applyPatch(steps(), 0, { kind: "insert_before", newStep: { type: "browser", description: "x" } });
    expect(out[0].id).toBeTruthy();
  });
});

describe("validatePatch + proposePatch (G1s)", () => {
  it("accepts the patch kinds and rejects unknown / malformed", () => {
    expect(validatePatch({ patch: "skip_current", reasoning: "unneeded" }).kind).toBe("skip_current");
    expect(validatePatch({ patch: "insert_before", newStep: { type: "browser" } }).kind).toBe("insert_before");
    expect(() => validatePatch({ patch: "insert_before" })).toThrow(/newStep/);
    expect(() => validatePatch({ patch: "nonsense" })).toThrow(/unknown patch kind/);
  });

  it("rejects a fixer patch introducing a non-page step type (no shell/connector escalation)", () => {
    expect(() => validatePatch({ patch: "insert_before", newStep: { type: "local_command", command: "rm -rf /" } })).toThrow(/may only introduce/);
    expect(() => validatePatch({ patch: "replace_current", newStep: { type: "connector", connector: "x" } })).toThrow(/may only introduce/);
    // a page-repair step is allowed
    expect(validatePatch({ patch: "insert_before", newStep: { type: "browser", description: "dismiss" } }).kind).toBe("insert_before");
  });
  it("proposePatch validates the injected fixer reply", async () => {
    const patch = await proposePatch({
      step: { id: "s1", type: "browser" },
      error: "cookie banner covers the button",
      failureKind: "verify_failed",
      invoke: async () => ({ patch: "insert_before", reasoning: "dismiss the cookie banner", newStep: { type: "browser", description: "Click Reject on the cookie banner" } })
    });
    expect(patch.kind).toBe("insert_before");
    expect(patch.newStep.description).toMatch(/cookie/i);
  });
});
