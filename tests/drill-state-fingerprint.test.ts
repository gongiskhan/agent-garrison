import { describe, expect, it } from "vitest";
import { routePattern, sameRouteAndHeading, shapeSimilarity, fingerprintPreFilterMatch, SHAPE_THRESHOLD } from "../fittings/seed/drill/lib/state-fingerprint.mjs";

describe("routePattern", () => {
  it("normalizes numeric path segments so /kb/entry/482 and /kb/entry/930 are the same pattern", () => {
    expect(routePattern("https://x/kb/entry/482")).toBe(routePattern("https://x/kb/entry/930"));
    expect(routePattern("https://x/kb/entry/482")).toBe("/kb/entry/:id");
  });
  it("falls back to the raw string for an unparseable url", () => {
    expect(routePattern("not a url")).toBe("not a url");
  });
});

describe("sameRouteAndHeading", () => {
  it("true only when BOTH route pattern and heading text match", () => {
    const a = { url: "https://x/build/1", headingText: "New build" };
    const b = { url: "https://x/build/2", headingText: "New build" };
    const c = { url: "https://x/build/2", headingText: "Building…" };
    expect(sameRouteAndHeading(a, b)).toBe(true);
    expect(sameRouteAndHeading(a, c)).toBe(false);
  });
});

// R11's threshold: Jaccard over tag/role-count tokens, >= 0.85 clears the bar.
describe("shapeSimilarity + SHAPE_THRESHOLD boundary", () => {
  it("identical sketches are 1.0; disjoint sketches are 0", () => {
    expect(shapeSimilarity("button:3,div:1", "button:3,div:1")).toBe(1);
    expect(shapeSimilarity("button:3", "input:2")).toBe(0);
  });
  it("both-empty sketches are treated as a match (1.0), not NaN", () => {
    expect(shapeSimilarity("", "")).toBe(1);
  });

  it("exactly at the 0.85 boundary clears the bar (inclusive >=)", () => {
    // A: 17 shared tokens. B: the SAME 17 tokens + 3 extra (20 total).
    // intersection=17, union=17+20-17=20, similarity=17/20=0.85 exactly.
    const shared = Array.from({ length: 17 }, (_, i) => `t${i}:1`);
    const a = shared.join(",");
    const b = [...shared, "u1:1", "u2:1", "u3:1"].join(",");
    expect(shapeSimilarity(a, b)).toBeCloseTo(0.85, 10);
    expect(fingerprintPreFilterMatch({ url: "https://x/a", headingText: "H1", shapeSketch: a }, { url: "https://x/b", headingText: "H2", shapeSketch: b })).toBe(true);
  });

  it("just below the boundary (one more extra token) rejects", () => {
    const shared = Array.from({ length: 17 }, (_, i) => `t${i}:1`);
    const a = shared.join(",");
    const b = [...shared, "u1:1", "u2:1", "u3:1", "u4:1"].join(","); // 4 extras -> 17/21 ≈ 0.8095
    const sim = shapeSimilarity(a, b);
    expect(sim).toBeLessThan(SHAPE_THRESHOLD);
    expect(fingerprintPreFilterMatch({ url: "https://x/a", headingText: "H1", shapeSketch: a }, { url: "https://x/b", headingText: "H2", shapeSketch: b })).toBe(false);
  });
});

describe("fingerprintPreFilterMatch (R11: same route+heading OR shape >= 0.85)", () => {
  it("matches on route+heading alone even with a wildly different shape", () => {
    const candidate = { url: "https://x/build/1", headingText: "New build", shapeSketch: "button:1" };
    const reference = { url: "https://x/build/2", headingText: "New build", shapeSketch: "div:99,span:50" };
    expect(fingerprintPreFilterMatch(candidate, reference)).toBe(true);
  });

  it("a realistic build-progress scenario: two in-progress snapshots both clear the bar against the 'building' reference; idle and complete do not", () => {
    // 13-token reference shape; a candidate differing by exactly 1 token
    // clears 0.85 (12/14 ≈ 0.857); idle/complete share only a handful of
    // tokens with it (structurally different renderings).
    const letters = "abcdefghijklm".split("");
    const building = letters.map((l) => `${l}:1`).join(",");
    const build8pct = [...letters.slice(0, 12), "n"].map((l) => `${l}:1`).join(","); // swaps "m" for "n"
    const build64pct = [...letters.slice(0, 12), "o"].map((l) => `${l}:1`).join(","); // swaps "m" for "o"
    const idle = "x:1,y:1,z:1".concat(",", letters.slice(0, 3).map((l) => `${l}:1`).join(",")); // shares only 3/13
    const complete = "p:1,q:1".concat(",", letters.slice(0, 2).map((l) => `${l}:1`).join(",")); // shares only 2/13

    const ref = { url: "https://x/build", headingText: "Building…", shapeSketch: building };
    const mk = (shapeSketch: string) => ({ url: "https://x/build", headingText: "Different heading each state", shapeSketch });

    expect(fingerprintPreFilterMatch(mk(build8pct), ref)).toBe(true);
    expect(fingerprintPreFilterMatch(mk(build64pct), ref)).toBe(true);
    expect(fingerprintPreFilterMatch(mk(idle), ref)).toBe(false);
    expect(fingerprintPreFilterMatch(mk(complete), ref)).toBe(false);
  });
});
