// Honesty gate (S6): a check whose expected outcome cannot exist without an
// interaction that never happened is reported as UNPROVEN, not passed.
//
// The failure this prevents is concrete and was live: "Pressing Shift+Enter
// inserts a newline" was judged from a screenshot of an untouched composer.
// The model passed it on the only visible fragment (a hint label), that verdict
// was cached, and it graduated into a committed spec that never presses
// Shift+Enter. One unobservable pass became a permanent deterministic lie.
import { describe, it, expect } from "vitest";
import { terminalFromAutomationRun } from "../fittings/seed/drill/lib/run-outcome.mjs";
import { graduationPlanFor } from "../fittings/seed/drill/lib/graduate.mjs";
import { assessAutomaticStateReference } from "../fittings/seed/drill/lib/states.mjs";
import { buildVisionPrompt } from "@/app/api/automations/vision/prompt";

const run = (result: any) => ({
  steps: [{ stepId: "chk", type: "verify", status: "completed", tier: "vision", result }]
});

describe("terminalFromAutomationRun", () => {
  it("reports a flagged verdict as unproven rather than passed", () => {
    const t = terminalFromAutomationRun(
      run({ passed: true, reasoning: "the hint label is visible", requiresInteraction: true, missingInteraction: "press Shift+Enter" }),
      "chk"
    );
    expect(t.kind).toBe("unproven");
    expect(t.code).toBe("requires-interaction");
    // Blamed on the check, not the app: nothing about the app was shown wrong.
    expect(t.component).toBe("drill");
    expect(t.message).toContain("press Shift+Enter");
    expect(t.missingInteraction).toBe("press Shift+Enter");
  });

  it("still passes an ordinary observable check", () => {
    expect(terminalFromAutomationRun(run({ passed: true, reasoning: "heading is visible" }), "chk").kind).toBe("passed");
  });

  it("leaves a real product failure as a failure, not unproven", () => {
    const t = terminalFromAutomationRun(run({ passed: false, reasoning: "heading missing" }), "chk");
    expect(t.kind).toBe("product-failure");
  });

  it("only trips on a strict boolean true", () => {
    // The model can emit a string; truthiness would make "false" trip the gate.
    for (const v of ["true", "false", 1, 0, null, undefined]) {
      expect(terminalFromAutomationRun(run({ passed: true, requiresInteraction: v }), "chk").kind).toBe("passed");
    }
  });
});

describe("quarantine of an unproven verdict", () => {
  const outcome = (result: any) => ({ status: "completed", tier: "vision", result });

  it("never graduates into a committed spec", () => {
    const flagged = outcome({ passed: true, assertion: { kind: "text-contains", text: "Shift+Enter" }, requiresInteraction: true });
    expect(graduationPlanFor({ id: "chk" }, flagged, { steps: [] })).toBeNull();
    // ...including the judgment path, which bypasses the assertion branch.
    expect(graduationPlanFor({ id: "chk", judgment: true }, flagged, { steps: [] })).toBeNull();
    // Control: the same verdict without the flag does graduate.
    const clean = outcome({ passed: true, assertion: { kind: "text-contains", text: "Shift+Enter" } });
    expect(graduationPlanFor({ id: "chk" }, clean, { steps: [] })).toEqual({
      assertion: { kind: "text-contains", text: "Shift+Enter" }
    });
  });

  it("never seeds a state reference from a page it could not verify", () => {
    const flagged = { evidencePath: "/e/step-001.jpg", result: { passed: true, requiresInteraction: true } };
    expect(assessAutomaticStateReference(flagged)).toMatchObject({ eligible: false, reason: "requires-interaction" });
    expect(assessAutomaticStateReference({ evidencePath: "/e/step-001.jpg", result: { passed: true } }).eligible).toBe(true);
  });
});

describe("the verify prompt's honesty contract", () => {
  const obs = { url: "http://x/chat", title: "Chat", headingText: "Chat", a11y: [] };

  it("tells the model the snapshot is static and asks for requiresInteraction", () => {
    const p = buildVisionPrompt("verify", obs, { description: "Pressing Shift+Enter inserts a newline" }, "/tmp/s.png");
    expect(p).toContain('"requiresInteraction": true|false');
    expect(p).toContain("missingInteraction");
    // The two clauses that keep it conservative.
    expect(p).toContain("Judge the OUTCOME, not the verb");
    expect(p).toContain("If you are unsure, set it false");
  });

  it("does not leak the gate into judge mode, which is qualitative by design", () => {
    const p = buildVisionPrompt("judge", obs, { description: "does this look right" }, "/tmp/s.png");
    expect(p).not.toContain("requiresInteraction");
    expect(p).not.toContain("Honesty gate");
  });

  it("keeps the reply contract last so clipping cannot drop it before the gate", () => {
    const p = buildVisionPrompt("verify", obs, { description: "x" }, "/tmp/s.png");
    expect(p.indexOf("Honesty gate")).toBeLessThan(p.indexOf("Reply ONLY valid single-line JSON"));
  });
});
