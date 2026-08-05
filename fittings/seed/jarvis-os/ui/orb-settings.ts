// Orb mode (Phase 3) — shared constants between the HUD (main.tsx,
// SettingsPanel.tsx) and the Garrison shell (JarvisPersistentFrame.tsx). Kept
// as pure data/validation, same shape as hud-color.ts, so both sides parse
// the persisted ~/.garrison/view-state/jarvis-os/default.json the same way.

export type OrbCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const ORB_CORNERS: OrbCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
export const DEFAULT_ORB_CORNER: OrbCorner = "bottom-right";
export const DEFAULT_ORB_MODE = false;

export function isValidOrbCorner(value: unknown): value is OrbCorner {
  return typeof value === "string" && (ORB_CORNERS as string[]).includes(value);
}

// Fixed, hardcoded orb geometry (Phase 3 scope cut — see JarvisPersistentFrame
// for why size/opacity aren't exposed in the settings panel yet). Shared here
// so the shell's drag/snap math and its docs agree with one source of truth.
export const ORB_WRAP_PX = 160; // outer draggable box the shell sizes the iframe to
export const ORB_VISIBLE_PX = 88; // diameter of the clip-path circle (the actual orb)
export const ORB_SCREEN_MARGIN_PX = 20; // gap from the viewport edge at rest
export const ORB_OPACITY = 0.96;
