import { describe, expect, it } from "vitest";
import {
  ASSERTION_KINDS,
  isAssertionKind,
  needsRemoteProbe,
  compareCount,
  evaluateTextContains,
  evaluateUrlMatches
} from "../fittings/seed/automations/lib/assertions.mjs";

// Engine delta 5 — richer deterministic assertions. Pure kind-routing logic;
// the remote-probe kinds (count/visible/attribute-equals) are exercised at the
// browser-default HTTP layer, not here.

describe("assertion kind vocabulary", () => {
  it("recognizes exactly the 5 supported kinds", () => {
    expect(ASSERTION_KINDS).toEqual(["text-contains", "count", "visible", "url-matches", "attribute-equals"]);
    expect(isAssertionKind("count")).toBe(true);
    expect(isAssertionKind("nonsense")).toBe(false);
  });
  it("flags exactly the kinds that need a live Playwright locator", () => {
    expect(needsRemoteProbe("count")).toBe(true);
    expect(needsRemoteProbe("visible")).toBe(true);
    expect(needsRemoteProbe("attribute-equals")).toBe(true);
    expect(needsRemoteProbe("text-contains")).toBe(false);
    expect(needsRemoteProbe("url-matches")).toBe(false);
  });
});

describe("compareCount", () => {
  it("supports eq/gte/lte/gt/lt", () => {
    expect(compareCount(3, "eq", 3)).toBe(true);
    expect(compareCount(3, "eq", 4)).toBe(false);
    expect(compareCount(3, "gte", 3)).toBe(true);
    expect(compareCount(2, "gte", 3)).toBe(false);
    expect(compareCount(3, "lte", 3)).toBe(true);
    expect(compareCount(4, "lte", 3)).toBe(false);
    expect(compareCount(4, "gt", 3)).toBe(true);
    expect(compareCount(2, "lt", 3)).toBe(true);
  });
  it("throws on an unknown op", () => {
    expect(() => compareCount(1, "neq" as any, 1)).toThrow(/unknown count op/);
  });
});

describe("evaluateTextContains (backward-compatible original kind)", () => {
  const obs = { title: "Chat", headingText: "Q3 Report", a11y: [{ role: "button", name: "Send" }] };
  it("case-insensitive substring over title+heading+a11y names", () => {
    expect(evaluateTextContains({ text: "q3" }, obs)).toBe(true);
    expect(evaluateTextContains({ text: "SEND" }, obs)).toBe(true);
    expect(evaluateTextContains({ text: "nope" }, obs)).toBe(false);
  });
  it("empty text never matches", () => {
    expect(evaluateTextContains({ text: "" }, obs)).toBe(false);
    expect(evaluateTextContains({}, obs)).toBe(false);
  });
});

describe("evaluateUrlMatches", () => {
  const obs = { url: "https://app.example.com/chat/thread-42" };
  it("substring mode (default)", () => {
    expect(evaluateUrlMatches({ pattern: "/chat/" }, obs)).toBe(true);
    expect(evaluateUrlMatches({ pattern: "/kb/" }, obs)).toBe(false);
  });
  it("regex mode", () => {
    expect(evaluateUrlMatches({ pattern: "/thread-\\d+$", mode: "regex" }, obs)).toBe(true);
    expect(evaluateUrlMatches({ pattern: "^https://other", mode: "regex" }, obs)).toBe(false);
  });
  it("no pattern never matches", () => {
    expect(evaluateUrlMatches({}, obs)).toBe(false);
  });
});
