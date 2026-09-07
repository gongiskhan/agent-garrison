import { describe, it, expect } from "vitest";
import { graceWindowMs, coerceEpCfg, EP_DEFAULTS } from "../fittings/seed/jarvis-os/ui/endpointing";

const CFG = { minMs: 350, maxMs: 2600 };

describe("graceWindowMs", () => {
  it("finished-sounding (eot→1) waits ~minMs; mid-thought (eot→0) waits ~maxMs", () => {
    expect(graceWindowMs(1, CFG)).toBe(350);
    expect(graceWindowMs(0, CFG)).toBe(2600);
    expect(graceWindowMs(0.5, CFG)).toBe(350 + (2600 - 350) * 0.5);
  });
  it("null/unknown eot uses a neutral 0.5", () => {
    expect(graceWindowMs(null, CFG)).toBe(graceWindowMs(0.5, CFG));
    expect(graceWindowMs(undefined, CFG)).toBe(graceWindowMs(0.5, CFG));
    expect(graceWindowMs(NaN, CFG)).toBe(graceWindowMs(0.5, CFG));
  });
  it("clamps out-of-range eot into [minMs, maxMs]", () => {
    expect(graceWindowMs(2, CFG)).toBe(350);   // clamped to 1
    expect(graceWindowMs(-5, CFG)).toBe(2600);  // clamped to 0
  });
});

describe("coerceEpCfg", () => {
  it("passes through a valid payload", () => {
    const j = { redemptionMs: 600, minMs: 400, maxMs: 3000, bargeinProb: 0.7, bargeinConfirmMs: 300, idleTimeoutMs: 60000 };
    expect(coerceEpCfg(j)).toEqual(j);
  });
  it("falls back per-field on missing/invalid values", () => {
    expect(coerceEpCfg({})).toEqual(EP_DEFAULTS);
    expect(coerceEpCfg({ minMs: -1, maxMs: "x", bargeinProb: 2 })).toMatchObject({
      minMs: EP_DEFAULTS.minMs, maxMs: EP_DEFAULTS.maxMs, bargeinProb: EP_DEFAULTS.bargeinProb
    });
  });
  it("accepts 0 for the barge-in-confirm and idle-timeout (0 = disabled)", () => {
    const c = coerceEpCfg({ bargeinConfirmMs: 0, idleTimeoutMs: 0 });
    expect(c.bargeinConfirmMs).toBe(0);
    expect(c.idleTimeoutMs).toBe(0);
  });
});
