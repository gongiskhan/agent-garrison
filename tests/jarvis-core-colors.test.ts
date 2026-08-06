import { describe, expect, it } from "vitest";
import {
  CORE_STATE_KEYS,
  DEFAULT_STATE_COLORS,
  hexToHsl,
  isDefaultStateColors,
  isValidStateColor,
  normalizeStateColors,
  orbPalettes
} from "../fittings/seed/jarvis-os/ui/core-colors";

// The palettes GraphCore shipped with, before they became user-settable. The
// point of these numbers is regression: picking a state's DEFAULT swatch has to
// land back on exactly this, or "repor cores" would silently change the look.
const SHIPPED = {
  idle: { inner: [0.52, 0.55, 0.72], outer: [0.52, 0.7, 0.42], edge: [0.52, 0.65, 0.52], hue: 0.52 },
  working: { inner: [0.88, 0.85, 0.8], outer: [0.88, 0.95, 0.55], edge: [0.88, 0.9, 0.64], hue: 0.88 },
  listening: { inner: [0.52, 0.85, 0.8], outer: [0.52, 0.95, 0.52], edge: [0.52, 0.9, 0.62], hue: 0.52 },
  speaking: { inner: [0.6, 0.22, 0.96], outer: [0.6, 0.45, 0.82], edge: [0.6, 0.35, 0.88], hue: 0.6 }
} as const;

// Hex is 8 bits per channel, so a hex round-trip cannot reproduce an HSL triple
// bit-for-bit. Hue and lightness survive to well under half a percent, but
// SATURATION does not: near white (speaking sits at l≈0.82) one 8-bit step is
// worth ~0.011 of saturation, so no hex exists that round-trips 0.45 any
// closer. Hence the looser bound on that channel alone — it is the format's
// resolution, not slack in the derivation.
const NEAR = [0.005, 0.012, 0.005];

function expectClose(actual: readonly number[], expected: readonly number[], label: string) {
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(actual[i] - expected[i]), `${label}[${i}] ${actual[i]} vs ${expected[i]}`).toBeLessThan(NEAR[i]);
  }
}

describe("jarvis orb state colours", () => {
  it("reproduces the shipped palettes from the default swatches", () => {
    const p = orbPalettes(DEFAULT_STATE_COLORS);
    for (const mode of ["idle", "working", "listening", "speaking"] as const) {
      expectClose(p[mode].inner, SHIPPED[mode].inner, `${mode}.inner`);
      expectClose(p[mode].outer, SHIPPED[mode].outer, `${mode}.outer`);
      expectClose(p[mode].edge, SHIPPED[mode].edge, `${mode}.edge`);
      expect(Math.abs(p[mode].hue - SHIPPED[mode].hue)).toBeLessThan(NEAR[0]);
    }
  });

  it("falls back to the shipped look when nothing is persisted", () => {
    expect(orbPalettes(undefined)).toEqual(orbPalettes(DEFAULT_STATE_COLORS));
    expect(orbPalettes({ listening: "not a colour" })).toEqual(orbPalettes(DEFAULT_STATE_COLORS));
  });

  it("moves a state's whole palette onto the picked hue", () => {
    const p = orbPalettes({ ...DEFAULT_STATE_COLORS, listening: "#22cc55" }); // green
    const hue = hexToHsl("#22cc55")![0];
    expect(Math.abs(p.listening.hue - hue)).toBeLessThan(NEAR[0]);
    for (const tone of ["inner", "outer", "edge"] as const) {
      expect(Math.abs(p.listening[tone][0] - hue)).toBeLessThan(NEAR[0]);
    }
  });

  it("keeps the picked colour as the rim, and derives a lighter core from it", () => {
    const p = orbPalettes({ ...DEFAULT_STATE_COLORS, listening: "#22cc55" });
    expectClose(p.listening.outer, hexToHsl("#22cc55")!, "listening.outer");
    expect(p.listening.inner[2]).toBeGreaterThan(p.listening.outer[2]);
    expect(p.listening.edge[2]).toBeGreaterThan(p.listening.outer[2]);
    expect(p.listening.edge[2]).toBeLessThan(p.listening.inner[2]);
  });

  it("drags idle along with the listening pick, since idle is listening at rest", () => {
    const p = orbPalettes({ ...DEFAULT_STATE_COLORS, listening: "#22cc55" });
    const hue = hexToHsl("#22cc55")![0];
    expect(Math.abs(p.idle.hue - hue)).toBeLessThan(NEAR[0]);
    // ...but dimmer and calmer than listening itself, or the two states would
    // stop being tellable apart.
    expect(p.idle.inner[1]).toBeLessThan(p.listening.inner[1]);
    expect(p.idle.inner[2]).toBeLessThan(p.listening.inner[2]);
  });

  it("leaves error and muted alone — they are semantic, not decorative", () => {
    const picked = orbPalettes({ listening: "#22cc55", thinking: "#22cc55", speaking: "#22cc55" });
    const shipped = orbPalettes(DEFAULT_STATE_COLORS);
    expect(picked.error).toEqual(shipped.error);
    expect(picked.muted).toEqual(shipped.muted);
    expect(picked.error.hue).toBe(0); // red
  });

  it("keeps an extreme pick visible instead of a black or blown-out ball", () => {
    const black = orbPalettes({ ...DEFAULT_STATE_COLORS, speaking: "#000000" });
    expect(black.speaking.outer[2]).toBeGreaterThanOrEqual(0.25);
    const white = orbPalettes({ ...DEFAULT_STATE_COLORS, speaking: "#ffffff" });
    expect(white.speaking.outer[2]).toBeLessThanOrEqual(0.92);
    // every tone of every mode stays inside the renderable band
    for (const p of Object.values(orbPalettes({ listening: "#000000", thinking: "#ffffff", speaking: "#000000" }))) {
      for (const tone of [p.inner, p.outer, p.edge]) {
        expect(tone[1]).toBeGreaterThanOrEqual(0);
        expect(tone[1]).toBeLessThanOrEqual(1);
        expect(tone[2]).toBeGreaterThanOrEqual(0);
        expect(tone[2]).toBeLessThanOrEqual(1);
      }
    }
  });

  it("treats a grey pick as grey rather than snapping to some arbitrary hue", () => {
    const p = orbPalettes({ ...DEFAULT_STATE_COLORS, thinking: "#808080" });
    expect(p.working.outer[1]).toBe(0);
  });

  describe("persisted-state parsing", () => {
    it("keeps the default for every key that is missing or malformed", () => {
      const merged = normalizeStateColors({ listening: "#22cc55", thinking: "nope" });
      expect(merged.listening).toBe("#22cc55");
      expect(merged.thinking).toBe(DEFAULT_STATE_COLORS.thinking);
      expect(merged.speaking).toBe(DEFAULT_STATE_COLORS.speaking);
    });

    it("survives junk without throwing", () => {
      for (const junk of [null, undefined, 42, "nope", [], { listening: 7 }]) {
        expect(normalizeStateColors(junk)).toEqual(DEFAULT_STATE_COLORS);
      }
    });

    it("normalises case so the reset button doesn't linger after a re-pick", () => {
      const merged = normalizeStateColors({ listening: DEFAULT_STATE_COLORS.listening.toUpperCase() });
      expect(isDefaultStateColors(merged)).toBe(true);
      expect(isDefaultStateColors({ ...DEFAULT_STATE_COLORS, speaking: "#22cc55" })).toBe(false);
    });
  });

  describe("hex parsing", () => {
    it("accepts only #rrggbb", () => {
      expect(isValidStateColor("#a1b2c3")).toBe(true);
      expect(isValidStateColor("#ABC")).toBe(false);
      expect(isValidStateColor("a1b2c3")).toBe(false);
      expect(isValidStateColor(null)).toBe(false);
      expect(hexToHsl("nope")).toBeNull();
    });

    it("round-trips the three defaults to the hues they are named for", () => {
      expect(CORE_STATE_KEYS).toEqual(["listening", "thinking", "speaking"]);
      expect(Math.abs(hexToHsl(DEFAULT_STATE_COLORS.listening)![0] - 0.52)).toBeLessThan(NEAR[0]); // cyan
      expect(Math.abs(hexToHsl(DEFAULT_STATE_COLORS.thinking)![0] - 0.88)).toBeLessThan(NEAR[0]); // magenta
      expect(Math.abs(hexToHsl(DEFAULT_STATE_COLORS.speaking)![0] - 0.6)).toBeLessThan(NEAR[0]); // blue-white
    });
  });
});
