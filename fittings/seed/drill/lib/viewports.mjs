// Named viewport presets (S19 responsive matrix). Shared by the authoring
// surface (tab sizing), the run path (per-viewport engine runs), and mobile
// (E4: the same steps compiled per viewport ARE the responsive test).

export const VIEWPORT_PRESETS = {
  desktop: { id: "desktop", label: "desktop", width: 1280, height: 800 },
  tablet: { id: "tablet", label: "tablet", width: 820, height: 1180 },
  mobile: { id: "mobile", label: "mobile", width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 }
};

export function resolveViewport(id) {
  const preset = VIEWPORT_PRESETS[id];
  if (!preset) throw new Error(`unknown viewport preset: ${id}`);
  return preset;
}

export function viewportList() {
  return Object.values(VIEWPORT_PRESETS);
}
