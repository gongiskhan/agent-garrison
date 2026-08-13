import { describe, it, expect } from "vitest";
import { DEFAULT_HUD_COLOR, hexToHue, hudTones, isValidHudColor, applyHudTones } from "../fittings/seed/jarvis-os/ui/hud-color";

describe("hexToHue", () => {
  it("extracts the hue of a saturated color", () => {
    expect(hexToHue("#ff0000")).toBeCloseTo(0, 0);
    expect(hexToHue("#00ff00")).toBeCloseTo(120, 0);
    expect(hexToHue("#0000ff")).toBeCloseTo(240, 0);
  });

  it("matches the shipped default's approximate hue", () => {
    // #c8322c ≈ hue 2-3° (the default --ember)
    expect(hexToHue(DEFAULT_HUD_COLOR)).toBeGreaterThan(0);
    expect(hexToHue(DEFAULT_HUD_COLOR)).toBeLessThan(10);
  });

  it("falls back on malformed input", () => {
    expect(hexToHue("not-a-color", 42)).toBe(42);
    expect(hexToHue("", 42)).toBe(42);
    expect(hexToHue("#abc", 42)).toBe(42); // 3-digit shorthand not accepted
  });

  it("falls back on achromatic (gray/black/white) picks instead of snapping to 0", () => {
    expect(hexToHue("#000000", 42)).toBe(42);
    expect(hexToHue("#ffffff", 42)).toBe(42);
    expect(hexToHue("#808080", 42)).toBe(42);
  });

  it("accepts hex without a leading #", () => {
    expect(hexToHue("ff0000")).toBeCloseTo(0, 0);
  });
});

describe("hudTones", () => {
  it("derives fixed-lightness tones that only track the picked hue", () => {
    const red = hudTones("#ff0000");
    const blue = hudTones("#0000ff");
    expect(red.accentH).toBeCloseTo(0, 0);
    expect(blue.accentH).toBeCloseTo(240, 0);
    // same role, different hue -> different hue token, same L/S shape
    expect(red.ember).toMatch(/^hsl\(0 60% 46%\)$/);
    expect(blue.ember).toMatch(/^hsl\(240 60% 46%\)$/);
  });

  it("is invariant to the picked color's lightness/saturation — a near-white or near-black pick still gets legible, mid/high-lightness accent tones", () => {
    // A pale, nearly-white pick still has *some* hue (e.g. a faint blue tint);
    // the derived ember/cobalt/white-hot must ignore its near-white lightness
    // and use the fixed per-role lightness instead.
    const paleBlue = hudTones("#eef2ff");
    expect(paleBlue.ember).toContain("46%");
    expect(paleBlue.cobalt).toContain("65%");
    expect(paleBlue.whiteHot).toContain("95%");

    const nearBlack = hudTones("#1a0033");
    expect(nearBlack.ember).toContain("46%");
    expect(nearBlack.cobalt).toContain("65%");
    expect(nearBlack.whiteHot).toContain("95%");
  });

  it("falls back to the default hue for a malformed or achromatic pick", () => {
    const fallback = hudTones("#808080");
    expect(fallback.accentH).toBe(5);
  });
});

describe("isValidHudColor", () => {
  it("accepts well-formed 6-digit hex", () => {
    expect(isValidHudColor("#c8322c")).toBe(true);
    expect(isValidHudColor("#ABCDEF")).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isValidHudColor("#abc")).toBe(false);
    expect(isValidHudColor("red")).toBe(false);
    expect(isValidHudColor(null)).toBe(false);
    expect(isValidHudColor(undefined)).toBe(false);
    expect(isValidHudColor(42)).toBe(false);
  });
});

describe("applyHudTones", () => {
  it("writes all four derived custom properties onto the given element", () => {
    const written: Record<string, string> = {};
    const fakeRoot = { style: { setProperty: (k: string, v: string) => { written[k] = v; } } };
    applyHudTones(fakeRoot, "#0000ff");
    expect(written["--accent-h"]).toBe("240");
    expect(written["--ember"]).toBe("hsl(240 60% 46%)");
    expect(written["--cobalt"]).toBe("hsl(240 95% 65%)");
    expect(written["--white-hot"]).toBe("hsl(240 22% 95%)");
  });
});
