// Lane A: a check the PLAN agent authored as deterministic.
//
// Planning used to be blind - it read the source, wrote plain-English criteria,
// and every single one had to be discovered by RUNNING it through a model. Now
// the plan agent drives the live app and, for a criterion that is a static fact
// about the loaded page, writes the assertion itself after validating it
// against that page through the engine's own evaluator.
//
// That buys a deterministic FIRST run, but it must not buy a committed spec:
// "I validated this once, on a page I had navigated to by hand" is a weaker
// claim than "a whole check passed end to end". `assertionSource: authored`
// carries that distinction, and these tests pin both halves of it - the check
// runs deterministically straight away, and the spec waits for a real pass.
import { describe, it, expect } from "vitest";
import { compileStepAutomation } from "../fittings/seed/drill/lib/compile.mjs";
import { emittableSteps, emitPageSpec, isProvenAssertion } from "../fittings/seed/drill/lib/spec-emit.mjs";
import { confirmsAuthoredAssertion, graduationPlanFor } from "../fittings/seed/drill/lib/graduate.mjs";

const book = { app: { url: "http://localhost:3000" } };
const page = { id: "login", title: "Login", path: "/login", areas: [], states: [] };

const authored = {
  id: "submit-button-present",
  mode: "e2e",
  description: "The login form shows a submit button labelled Entrar.",
  assertion: { kind: "visible", role: "button", name: "Entrar" },
  assertionSource: "authored"
};
const proven = { ...authored, assertionSource: undefined };

describe("an authored assertion runs deterministically from the first pass", () => {
  it("compiles as cachedAssertion, exactly like a graduated one", () => {
    // This is the whole point: no model call, on run one.
    const steps = compileStepAutomation(book, page, authored).steps;
    expect(steps.at(-1)).toMatchObject({
      type: "verify",
      cachedAssertion: { kind: "visible", role: "button", name: "Entrar" }
    });
  });

  it("is still withheld from a blind adversarial pass", () => {
    // Blind withholds the ANSWER. An authored assertion is an answer.
    expect(compileStepAutomation(book, page, authored, { blind: true }).steps.at(-1).cachedAssertion).toBeUndefined();
  });
});

describe("but it does not reach the committed spec until a run proves it", () => {
  it("is excluded from emission while assertionSource is authored", () => {
    expect(isProvenAssertion(authored)).toBe(false);
    expect(emittableSteps({ ...page, steps: [authored] })).toHaveLength(0);
    expect(emitPageSpec({ ...page, steps: [authored] }, "http://localhost:3000/login")).not.toContain("submit-button-present");
  });

  it("emits once the marker is cleared", () => {
    expect(isProvenAssertion(proven)).toBe(true);
    expect(emittableSteps({ ...page, steps: [proven] })).toHaveLength(1);
    expect(emitPageSpec({ ...page, steps: [proven] }, "http://localhost:3000/login")).toContain("submit-button-present");
  });

  it("a run-discovered assertion still emits immediately - this changes nothing for it", () => {
    // Backward compatibility: every assertion written before lane A existed
    // came from a passing run and carries no assertionSource at all.
    const legacy = { id: "x", mode: "e2e", description: "d", assertion: { kind: "visible", testId: "t" } };
    expect(isProvenAssertion(legacy)).toBe(true);
  });
});

describe("confirmsAuthoredAssertion", () => {
  const outcome = (over = {}) => ({ status: "completed", tier: "cached", result: {}, ...over });

  it("promotes when the authored assertion itself held on the deterministic path", () => {
    expect(confirmsAuthoredAssertion(authored, outcome())).toBe(true);
  });

  it("does NOT promote on a vision pass - that means the authored assertion did not hold", () => {
    // The engine falls through to vision only when the deterministic assertion
    // failed. Graduation handles that case and overwrites the assertion with
    // what actually proved true; promoting here would bless the wrong one.
    expect(confirmsAuthoredAssertion(authored, outcome({ tier: "vision" }))).toBe(false);
    expect(confirmsAuthoredAssertion(authored, outcome({ tier: "recovered" }))).toBe(false);
  });

  it("does not promote a failed check, or a step that was never plan-authored", () => {
    expect(confirmsAuthoredAssertion(authored, outcome({ status: "failed" }))).toBe(false);
    expect(confirmsAuthoredAssertion(authored, null)).toBe(false);
    expect(confirmsAuthoredAssertion(proven, outcome())).toBe(false);
    expect(confirmsAuthoredAssertion({ id: "x" }, outcome())).toBe(false);
  });

  it("graduation stays out of the way of a passing authored assertion", () => {
    // tier "cached" was never a graduation trigger, and must not become one -
    // the promotion path owns this step, and a double-write would race it.
    expect(graduationPlanFor(authored, outcome(), { steps: [] })).toBeNull();
  });
});
