import { describe, it, expect } from "vitest";
import path from "node:path";

const LIB = path.resolve(__dirname, "..", "fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs");

// isWorkflowTarget / workflowTurnPrefix are this-free methods on RoutedGateway —
// test them via the prototype without constructing the full gateway.
describe("workflow target launchability (s6a)", () => {
  it("isWorkflowTarget detects type:workflow only", async () => {
    const { RoutedGateway } = await import(LIB);
    const isWf = RoutedGateway.prototype.isWorkflowTarget;
    expect(isWf.call(null, { target: { type: "workflow", workflow: "babysit-prs" } })).toBe(true);
    expect(isWf.call(null, { target: { type: "runtime-target", model: "opus" } })).toBe(false);
    expect(isWf.call(null, { target: { type: "secondary", runtime: "codex" } })).toBe(false);
    expect(isWf.call(null, {})).toBe(false);
    expect(isWf.call(null, { target: null })).toBe(false);
  });

  it("workflowTurnPrefix names the workflow + instructs the Workflow tool", async () => {
    const { RoutedGateway } = await import(LIB);
    const pfx = RoutedGateway.prototype.workflowTurnPrefix;
    const out = pfx.call(null, {
      target: { type: "workflow", workflow: "babysit-prs" },
      targetId: "workflow:babysit-prs"
    });
    expect(out).toContain("babysit-prs");
    expect(out).toContain("Workflow tool");
    expect(out).toContain("[workflow: babysit-prs]");
  });

  it("workflowTurnPrefix falls back to the targetId name when target.workflow is absent", async () => {
    const { RoutedGateway } = await import(LIB);
    const pfx = RoutedGateway.prototype.workflowTurnPrefix;
    expect(pfx.call(null, { targetId: "workflow:deploy" })).toContain("deploy");
  });
});
