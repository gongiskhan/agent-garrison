// Per-state orb colour — one user-picked swatch per headline state
// (listening / thinking / speaking) → the three-tone palettes GraphCore lerps
// toward. Extracted from GraphCore.tsx for the same reason hud-color.ts was
// extracted from main.tsx: the maths is pure and worth testing without pulling
// in Three.js or the React bundle.
//
// How this differs from hud-color.ts, deliberately: the HUD *chrome* keeps only
// the picked HUE and throws the rest away, because chrome has to stay legible
// against fixed body text. The orb carries no text, so here the picked colour
// survives as-is — pick a dusty rose and the orb is a dusty rose, not a neon
// one.
//
// The pick IS the `outer` tone (the rim — the most chromatic of the three and
// what the eye actually reads as "the colour of the orb"). `inner` (the bright
// core tint) and `edge` (the links) are derived from it by exactly the offsets
// the shipped palettes already use for that state, so:
//
//   - picking a state's default swatch reproduces today's palette exactly, and
//   - any other pick keeps the same internal contrast between the three tones,
//     which is what stops a pick from flattening the orb into one blob.
//
// idle follows the LISTENING pick — GraphCore documents idle as "a resting
// version of listening", so leaving it pinned to cyan while listening is green
// would just look broken. error and muted are NOT user-settable: error is a
// semantic "something is wrong" signal that has to stay distinct from whatever
// the user chose, and muted is the absence of colour by definition.

export type CoreStateKey = "listening" | "thinking" | "speaking";

export const CORE_STATE_KEYS: CoreStateKey[] = ["listening", "thinking", "speaking"];

export type StateColors = Record<CoreStateKey, string>;

// The shipped look, as hex. Each is the `outer` tone of the palette that was
// hardcoded in GraphCore: cyan, magenta/pink, near-white blue.
export const DEFAULT_STATE_COLORS: StateColors = {
  listening: "#10ddf9",
  thinking: "#f91fbc",
  speaking: "#bccde6"
};

export const CORE_STATE_LABEL: Record<CoreStateKey, string> = {
  listening: "a ouvir",
  thinking: "a pensar",
  speaking: "a falar"
};

// three.js HSL: h, s, l all in 0..1.
export type Hsl = [number, number, number];

export type OrbPalette = {
  inner: Hsl;
  outer: Hsl;
  edge: Hsl;
  hue: number;
};

export type OrbPaletteKey = "idle" | "working" | "listening" | "speaking" | "error" | "muted";
export type OrbPalettes = Record<OrbPaletteKey, OrbPalette>;

// Offsets from the picked (outer) tone, per state. Read them as "how far the
// other two tones sit from the rim" — lifted verbatim from the differences in
// the palettes GraphCore shipped with, which is what makes the default pick a
// no-op.
type Offset = { ds: number; dl: number };
const OFFSETS: Record<CoreStateKey, { inner: Offset; edge: Offset }> = {
  listening: { inner: { ds: -0.1, dl: 0.28 }, edge: { ds: -0.05, dl: 0.1 } },
  thinking: { inner: { ds: -0.1, dl: 0.25 }, edge: { ds: -0.05, dl: 0.09 } },
  speaking: { inner: { ds: -0.23, dl: 0.14 }, edge: { ds: -0.1, dl: 0.06 } }
};

// idle is derived from the LISTENING pick, with its own (dimmer, calmer)
// offsets — again taken straight from the shipped idle palette.
const IDLE_OFFSETS = {
  inner: { ds: -0.4, dl: 0.2 },
  outer: { ds: -0.25, dl: -0.1 },
  edge: { ds: -0.3, dl: 0.0 }
};

// Fixed, never user-settable (see the header note).
const ERROR_PALETTE: OrbPalette = {
  inner: [0.0, 0.85, 0.8],
  outer: [0.0, 0.95, 0.48],
  edge: [0.0, 0.9, 0.58],
  hue: 0.0
};
const MUTED_PALETTE: OrbPalette = {
  inner: [0.6, 0.05, 0.7],
  outer: [0.6, 0.08, 0.4],
  edge: [0.6, 0.06, 0.5],
  hue: 0.6
};

// A pick darker than this renders as a black ball on the near-black HUD (the
// orb is drawn additively); brighter than this and the bloom pass blows the
// whole cloud into a white disc. Clamping the RIM keeps every derived tone in
// range too, since they only move outward from it by the offsets above.
const MIN_PICK_L = 0.25;
const MAX_PICK_L = 0.92;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function isValidStateColor(hex: unknown): hex is string {
  return typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex.trim());
}

// #rrggbb → three.js HSL. Returns null for anything malformed so callers can
// fall back to the default rather than silently rendering black.
export function hexToHsl(hex: string): Hsl | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, l]; // achromatic — a grey pick is a grey orb
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h / 360, clamp01(s), l];
}

function shift([h, s, l]: Hsl, off: Offset): Hsl {
  return [h, clamp01(s + off.ds), clamp01(l + off.dl)];
}

// The picked rim tone for one state, clamped into the visible band.
function pickedOuter(hex: string, fallback: string): Hsl {
  const hsl = hexToHsl(hex) ?? hexToHsl(fallback) ?? [0, 0, 0.5];
  const l = Math.min(MAX_PICK_L, Math.max(MIN_PICK_L, hsl[2]));
  return [hsl[0], hsl[1], l];
}

function statePalette(key: CoreStateKey, hex: string): OrbPalette {
  const outer = pickedOuter(hex, DEFAULT_STATE_COLORS[key]);
  const off = OFFSETS[key];
  return {
    inner: shift(outer, off.inner),
    outer,
    edge: shift(outer, off.edge),
    hue: outer[0]
  };
}

// Merge whatever came back from the persisted view-state over the defaults.
// Anything missing or malformed keeps its default — a corrupt settings file
// must never leave the orb invisible.
export function normalizeStateColors(raw: unknown): StateColors {
  const out: StateColors = { ...DEFAULT_STATE_COLORS };
  if (raw && typeof raw === "object") {
    for (const key of CORE_STATE_KEYS) {
      const value = (raw as Record<string, unknown>)[key];
      if (isValidStateColor(value)) out[key] = value.trim().toLowerCase();
    }
  }
  return out;
}

export function isDefaultStateColors(colors: StateColors): boolean {
  return CORE_STATE_KEYS.every(
    (k) => (colors[k] || "").toLowerCase() === DEFAULT_STATE_COLORS[k].toLowerCase()
  );
}

// The full six-mode palette set GraphCore renders from.
export function orbPalettes(raw?: unknown): OrbPalettes {
  const colors = normalizeStateColors(raw);
  const listening = statePalette("listening", colors.listening);
  const idleBase = listening.outer;
  return {
    idle: {
      inner: shift(idleBase, IDLE_OFFSETS.inner),
      outer: shift(idleBase, IDLE_OFFSETS.outer),
      edge: shift(idleBase, IDLE_OFFSETS.edge),
      hue: idleBase[0]
    },
    working: statePalette("thinking", colors.thinking),
    listening,
    speaking: statePalette("speaking", colors.speaking),
    error: ERROR_PALETTE,
    muted: MUTED_PALETTE
  };
}
