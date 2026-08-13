// Pure HUD color derivation — one user-picked swatch → the CSS custom
// properties the stylesheet actually reads (--accent-h / --ember / --cobalt /
// --white-hot). Extracted from main.tsx so it's unit-testable without
// importing the React bundle (mirrors deep-link.ts / voice-phrases.ts).
//
// Design: only the picked color's HUE survives into the derived tones — its
// lightness and saturation are discarded and replaced with fixed, per-role
// values tuned to sit close to the shipped defaults at hue≈5 (ember #c8322c ≈
// hsl(5 64% 48%), cobalt #ff5c50 ≈ hsl(6 100% 66%), white-hot #fff0ec ≈
// hsl(11 100% 96%) — desaturated here so a bright pick doesn't read "neon").
// That is what keeps the HUD legible for ANY pick: a user choosing near-white
// or near-black in the swatch can't wash out ember's mid-lightness border
// color or blow out white-hot's near-white text color, because their
// lightness never reaches those roles at all — the background (--bg) and
// body text (--ink/--ink-dim/--ink-faint) stay fixed dark/light in
// styles.css, so contrast against them never depends on the user's pick.
// --err (red) also stays fixed — it's a semantic "something's wrong" signal,
// not decorative, and must stay visually distinct from whatever hue the user
// chose for the accent.

export const DEFAULT_HUD_COLOR = "#c8322c"; // matches the shipped --ember default
const DEFAULT_HUE = 5; // matches the shipped --accent-h default

export type HudTones = {
  accentH: number;
  ember: string;
  cobalt: string;
  whiteHot: string;
};

// #rrggbb → hue in degrees [0, 360). Returns `fallback` for anything that
// isn't a well-formed 6-digit hex, and for achromatic picks (pure gray/
// black/white have no hue to extract — keep the current accent rather than
// snapping to an arbitrary 0).
export function hexToHue(hex: string, fallback: number = DEFAULT_HUE): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || "").trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return fallback;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

// The full derived tone set for a picked swatch. `hex` is whatever the
// persisted view-state (or the <input type="color"> element) hands back;
// malformed/absent input falls back to the shipped default hue.
export function hudTones(hex: string): HudTones {
  const h = Math.round(hexToHue(hex));
  return {
    accentH: h,
    ember: `hsl(${h} 60% 46%)`,
    cobalt: `hsl(${h} 95% 65%)`,
    whiteHot: `hsl(${h} 22% 95%)`
  };
}

export function isValidHudColor(hex: unknown): hex is string {
  return typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex.trim());
}

// Apply the derived tones as inline CSS custom properties on the given
// element (document.documentElement in production; a plain object in tests).
// Kept separate from hudTones() so the pure math stays trivially testable.
export function applyHudTones(root: { style: { setProperty(name: string, value: string): void } }, hex: string): void {
  const t = hudTones(hex);
  root.style.setProperty("--accent-h", String(t.accentH));
  root.style.setProperty("--ember", t.ember);
  root.style.setProperty("--cobalt", t.cobalt);
  root.style.setProperty("--white-hot", t.whiteHot);
}
