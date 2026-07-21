import { describe, expect, it } from "vitest";
import {
  ENFORCEMENT_DEGRADATIONS,
  degradationsForEngine,
  isEnforcementDegraded
} from "@/lib/runtime-degradations";

describe("runtime degradations (S2d)", () => {
  it("claude-code is never degraded", () => {
    expect(isEnforcementDegraded("claude-code")).toBe(false);
    expect(degradationsForEngine("claude-code")).toEqual([]);
  });

  it("an unset/undefined engine reads as claude-code (not degraded)", () => {
    expect(isEnforcementDegraded(undefined)).toBe(false);
    expect(isEnforcementDegraded(null)).toBe(false);
    expect(degradationsForEngine(undefined)).toEqual([]);
  });

  it("every non-claude primary carries the full enforcement-degradation list", () => {
    for (const engine of ["codex", "gemini", "opencode", "agent-sdk"]) {
      expect(isEnforcementDegraded(engine)).toBe(true);
      expect(degradationsForEngine(engine)).toBe(ENFORCEMENT_DEGRADATIONS);
      expect(degradationsForEngine(engine).length).toBeGreaterThan(0);
    }
  });

  it("each degradation names a behavior, its advisory form, and why", () => {
    for (const d of ENFORCEMENT_DEGRADATIONS) {
      expect(d.behavior).toBeTruthy();
      expect(d.advisory).toBeTruthy();
      expect(d.why).toBeTruthy();
    }
  });
});
