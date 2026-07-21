import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPickScript, buildResolveScript, buildResolveManyScript, rectToPercent, anchorsToLocatorHint } from "../fittings/seed/drill/lib/picker.mjs";

// D4/B2/B3 — pure script-builders + pure geometry/compile helpers. Actual
// in-page execution is exercised in tests/drill-authoring.test.ts against a
// real browser-default + fixture page.

let dir: string;
let stubVendorPath: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-picker-"));
  stubVendorPath = path.join(dir, "picker-vendor.js");
  writeFileSync(stubVendorPath, "window.__drillVendor = { finder: function(){}, getCssSelector: function(){} };");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildPickScript", () => {
  it("embeds the vendor bundle text and the pick coordinates, and is syntactically valid JS", () => {
    const js = buildPickScript(120, 340, stubVendorPath);
    expect(js).toContain("window.__drillVendor");
    expect(js).toContain("document.elementFromPoint(120, 340)");
    expect(js).toContain("__drillAnchorsFor");
    // parseable as an expression body (wrapped so `new Function` accepts a
    // top-level function declaration followed by an IIFE — mirrors what CDP's
    // Runtime.evaluate does when run as a classic script)
    expect(() => new Function(js)).not.toThrow();
  });

  it("rejects non-finite coordinates rather than emitting an injectable script", () => {
    expect(() => buildPickScript(NaN, 10, stubVendorPath)).toThrow(/finite number/);
    expect(() => buildPickScript(10, "x" as any, stubVendorPath)).toThrow(/finite number/);
  });
});

describe("buildResolveScript", () => {
  it("embeds the anchor ladder in testId -> css -> xpath -> text order", () => {
    const js = buildResolveScript({ testId: "chat-composer", css: "[data-testid=chat-composer]", xpath: "//div[1]", text: "Send" });
    const testIdIdx = js.indexOf("a.testId");
    const cssIdx = js.indexOf("a.css");
    const xpathIdx = js.indexOf("a.xpath");
    const textIdx = js.indexOf("a.text");
    expect(testIdIdx).toBeGreaterThan(-1);
    expect(testIdIdx).toBeLessThan(cssIdx);
    expect(cssIdx).toBeLessThan(xpathIdx);
    expect(xpathIdx).toBeLessThan(textIdx);
    expect(() => new Function(js)).not.toThrow();
  });

  it("JSON-embeds the anchors object safely (no injection via a crafted text field)", () => {
    const js = buildResolveScript({ text: '"); alert(1); ("' });
    expect(() => new Function(js)).not.toThrow();
  });

  it("handles a null/undefined anchors object without throwing at build time", () => {
    expect(() => buildResolveScript(undefined)).not.toThrow();
    expect(() => buildResolveScript(null as any)).not.toThrow();
  });
});

describe("buildResolveManyScript", () => {
  it("resolves several identified anchors in one syntactically valid eval", () => {
    const js = buildResolveManyScript([
      { id: "hero", anchors: { testId: "hero" } },
      { id: "send", anchors: { text: 'Send "); safely' } }
    ]);
    expect(js).toContain("__drillResolve");
    expect(js).toContain('"id":"hero"');
    expect(js).toContain('"id":"send"');
    expect(() => new Function(js)).not.toThrow();
  });
});

describe("rectToPercent", () => {
  it("converts a viewport-relative rect to percentages", () => {
    const pct = rectToPercent({ x: 100, y: 50, width: 200, height: 40 }, { w: 1000, h: 500 });
    expect(pct).toEqual({ leftPct: 10, topPct: 10, widthPct: 20, heightPct: 8 });
  });
  it("returns null for a missing rect or a zero-sized viewport", () => {
    expect(rectToPercent(null, { w: 1000, h: 500 })).toBeNull();
    expect(rectToPercent({ x: 0, y: 0, width: 1, height: 1 }, { w: 0, h: 0 })).toBeNull();
  });
});

describe("anchorsToLocatorHint (B12/B8 compile-to-engine-vocabulary)", () => {
  it("prefers testId, then css, then xpath (as a Playwright xpath= selector), then role+name, then text", () => {
    expect(anchorsToLocatorHint({ testId: "x", css: ".y" })).toEqual({ testId: "x" });
    expect(anchorsToLocatorHint({ css: ".y", xpath: "//a" })).toEqual({ selector: ".y" });
    expect(anchorsToLocatorHint({ xpath: "//a[1]" })).toEqual({ selector: "xpath=//a[1]" });
    expect(anchorsToLocatorHint({ role: "button", ariaLabel: "Send" })).toEqual({ role: "button", name: "Send" });
    expect(anchorsToLocatorHint({ text: "Send" })).toEqual({ text: "Send" });
  });
  it("throws when no anchor is usable, but null/undefined is not an error (nothing to compile yet)", () => {
    expect(() => anchorsToLocatorHint({})).toThrow(/no usable anchor/);
    expect(anchorsToLocatorHint(null)).toEqual({});
    expect(anchorsToLocatorHint(undefined)).toEqual({});
  });
});
