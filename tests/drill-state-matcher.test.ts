import { describe, expect, it } from "vitest";
import { matchByAssertion, matchByFingerprint, matchState } from "../fittings/seed/drill/lib/state-matcher.mjs";

// R11/C6/Q7 — the matcher ladder. Ambiguity (0 or >=2 clearing the bar at
// either rung) ALWAYS escalates to vision, never guesses.

const states = [
  { id: "default", label: "default" },
  { id: "building", label: "building", fingerprint: { url: "https://x/build", headingText: "Building", shapeSketch: "a:1,b:1,c:1" } },
  { id: "complete", label: "complete", fingerprint: { url: "https://x/build", headingText: "Complete", shapeSketch: "x:1,y:1,z:1" } }
];

describe("matchByAssertion", () => {
  it("exactly one passing assertion is a match", () => {
    const results = new Map([["default", false], ["building", true], ["complete", false]]);
    expect(matchByAssertion(states, results)).toEqual({ matched: "building", via: "assertion" });
  });
  it("zero passing -> null (fall through)", () => {
    const results = new Map([["default", false], ["building", false], ["complete", false]]);
    expect(matchByAssertion(states, results)).toBeNull();
  });
  it("two or more passing -> null (ambiguous, never guesses)", () => {
    const results = new Map([["building", true], ["complete", true]]);
    expect(matchByAssertion(states, results)).toBeNull();
  });
  it("an empty/undefined results map -> null", () => {
    expect(matchByAssertion(states, undefined)).toBeNull();
    expect(matchByAssertion(states, new Map())).toBeNull();
  });
});

describe("matchByFingerprint", () => {
  it("exactly one state clearing the pre-filter bar is a match", () => {
    const candidate = { url: "https://x/build", headingText: "Building", shapeSketch: "a:1,b:1,c:1" };
    expect(matchByFingerprint(states, candidate)).toEqual({ matched: "building", via: "fingerprint" });
  });
  it("no state clearing the bar -> null", () => {
    const candidate = { url: "https://x/other", headingText: "Nope", shapeSketch: "q:1,r:1" };
    expect(matchByFingerprint(states, candidate)).toBeNull();
  });
  it("states with no fingerprint at all (e.g. 'default') are never candidates", () => {
    // "default" has no fingerprint — even a wildly matching url can't select it here.
    const candidate = { url: "https://x/anything", headingText: "Anything", shapeSketch: "" };
    expect(matchByFingerprint(states, candidate)).toBeNull();
  });
});

describe("matchState — the full ladder", () => {
  it("prefers a clean assertion match over fingerprint entirely", () => {
    const deterministicResults = new Map([["building", true]]);
    const candidateParts = { url: "https://x/build", headingText: "Complete", shapeSketch: "x:1,y:1,z:1" }; // would ALSO clear complete's fingerprint
    const r = matchState(states, { deterministicResults, candidateParts });
    expect(r).toEqual({ matched: "building", via: "assertion" }); // assertion wins over the fingerprint pull toward "complete"
  });

  it("falls to fingerprint when no assertion resolved", () => {
    const candidateParts = { url: "https://x/build", headingText: "Complete", shapeSketch: "x:1,y:1,z:1" };
    const r = matchState(states, { deterministicResults: new Map(), candidateParts });
    expect(r).toEqual({ matched: "complete", via: "fingerprint" });
  });

  it("escalates to vision when neither rung resolves unambiguously", () => {
    const candidateParts = { url: "https://x/unknown", headingText: "???", shapeSketch: "" };
    const r = matchState(states, { deterministicResults: new Map(), candidateParts });
    expect(r).toEqual({ matched: null, via: "vision" });
  });

  it("escalates to vision on ambiguity even if fingerprint ALONE would have been ambiguous but assertion also failed", () => {
    // two states' fingerprints both clear (contrived: identical shape) -> ambiguous -> vision
    const ambiguousStates = [
      { id: "a", label: "a", fingerprint: { url: "https://x/p", headingText: "H", shapeSketch: "t:1" } },
      { id: "b", label: "b", fingerprint: { url: "https://x/p", headingText: "H", shapeSketch: "t:1" } }
    ];
    const r = matchState(ambiguousStates, { deterministicResults: new Map(), candidateParts: { url: "https://x/p", headingText: "H", shapeSketch: "t:1" } });
    expect(r).toEqual({ matched: null, via: "vision" });
  });
});
