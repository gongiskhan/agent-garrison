import { describe, expect, it } from "vitest";
import {
  legacyInfrastructureFailure,
  terminalFromAutomationRun,
  terminalFromTransportError,
  terminalOpensCircuit
} from "../fittings/seed/drill/lib/run-outcome.mjs";

const completed = (result: any = { passed: true }) => ({
  id: "run-1",
  status: "completed",
  steps: [{
    stepId: "check",
    status: "completed",
    tier: "vision",
    durationMs: 17,
    evidencePath: "/engine/evidence/check.jpg",
    result
  }]
});

describe("Drill authoritative terminal outcomes", () => {
  it("keeps assertion failures in the product finding path", () => {
    const terminal = terminalFromAutomationRun(
      completed({ passed: false, reasoning: "The checkout total is wrong" }),
      "check"
    );
    expect(terminal).toMatchObject({
      kind: "product-failure",
      source: "step",
      code: "assertion-failed",
      component: "app",
      message: "The checkout total is wrong",
      tier: "vision",
      evidencePath: "/engine/evidence/check.jpg"
    });
    expect(terminalOpensCircuit(terminal)).toBe(false);
  });

  it("uses structured infrastructure metadata without inspecting prose", () => {
    const terminal = terminalFromAutomationRun({
      id: "run-2",
      status: "failed",
      steps: [{
        stepId: "check",
        status: "failed",
        error: "arbitrary localized message",
        failure: {
          class: "infrastructure",
          component: "vision",
          code: "model-gateway-overloaded",
          retryable: true
        }
      }]
    }, "check");
    expect(terminal).toMatchObject({
      kind: "infra-failure",
      source: "step",
      component: "vision",
      code: "model-gateway-overloaded",
      message: "arbitrary localized message"
    });
    expect(terminalOpensCircuit(terminal)).toBe(true);
  });

  it("keeps a product failure primary when its fixer also has an infrastructure outage", () => {
    const terminal = terminalFromAutomationRun({
      id: "run-layered",
      status: "failed",
      failure: {
        class: "product",
        component: "app",
        code: "verify-interaction-failed",
        retryable: false
      },
      recoveryFailure: {
        class: "infrastructure",
        component: "fixer",
        code: "fixer-http-503",
        retryable: true
      },
      steps: [{
        stepId: "check",
        status: "failed",
        error: "The checkout total is wrong",
        fixerNote: "fixer unusable: fixer 503",
        failure: {
          class: "product",
          component: "app",
          code: "verify-interaction-failed",
          retryable: false
        },
        recoveryFailure: {
          class: "infrastructure",
          component: "fixer",
          code: "fixer-http-503",
          retryable: true
        }
      }]
    }, "check");

    expect(terminal).toMatchObject({
      kind: "product-failure",
      component: "app",
      code: "verify-interaction-failed",
      message: "The checkout total is wrong",
      recoveryFailure: {
        kind: "infra-failure",
        source: "recovery",
        component: "fixer",
        code: "fixer-http-503",
        message: "fixer unusable: fixer 503"
      }
    });
    expect(terminalOpensCircuit(terminal)).toBe(false);
  });

  it("recognizes only narrow, anchored legacy infrastructure messages", () => {
    expect(legacyInfrastructureFailure("vision HTTP 503: overloaded")).toEqual({
      component: "vision",
      code: "vision-http-503"
    });
    expect(legacyInfrastructureFailure("automations 502")).toEqual({
      component: "automations",
      code: "automations-http-502"
    });
    expect(terminalFromAutomationRun({
      status: "failed",
      steps: [{ stepId: "check", status: "failed", error: "vision HTTP 503: overloaded" }]
    }, "check")).toMatchObject({
      kind: "infra-failure",
      component: "vision",
      code: "vision-http-503"
    });

    // Product copy can legitimately mention these words. Broad substring
    // matching would silently hide this real defect from triage.
    const productText = "The error panel says connection refused after checkout";
    expect(legacyInfrastructureFailure(productText)).toBeNull();
    expect(terminalFromAutomationRun({
      status: "failed",
      steps: [{ stepId: "check", status: "failed", error: productText }]
    }, "check")).toMatchObject({
      kind: "product-failure",
      component: "app",
      message: productText
    });
  });

  it("marks a missing target result incomplete instead of inventing a product failure", () => {
    const terminal = terminalFromAutomationRun({
      id: "run-3",
      status: "failed",
      error: "unexpected engine termination",
      steps: [{ stepId: "__drill_navigate", status: "completed" }]
    }, "check");
    expect(terminal).toMatchObject({
      kind: "incomplete",
      source: "run",
      code: "unclassified-failure",
      component: "automations"
    });
    expect(terminalOpensCircuit(terminal)).toBe(true);
  });

  it("treats direct-call errors as transport failures and opens the circuit", () => {
    expect(terminalFromTransportError(new Error("ECONNREFUSED: 127.0.0.1"))).toMatchObject({
      kind: "infra-failure",
      source: "transport",
      code: "transport-econnrefused",
      component: "automations"
    });
    expect(terminalOpensCircuit(terminalFromTransportError(new Error("malformed HTTP response")))).toBe(true);
  });

  it("preserves pass metadata for display without hydration", () => {
    expect(terminalFromAutomationRun(completed({ passed: true, reasoning: "The checkout is readable." }), "check")).toMatchObject({
      kind: "passed",
      source: "step",
      code: "completed",
      tier: "vision",
      evidencePath: "/engine/evidence/check.jpg",
      durationMs: 17,
      reasoning: "The checkout is readable."
    });
  });
});
