// How far above the viewport bottom the fixed push pills must sit so they clear
// the composer AND everything the composer floats above itself.
//
// The composer is not just its box. Three overlays are absolutely positioned
// descendants anchored to its top edge (`bottom: 100%`): the voice panel
// (.wcv-panel, "LISTENING ... speak now"), the slash-command menu
// (.cc-slashmenu) and the rail flight menu (.cc-railmenu). Measuring the
// composer's height alone parked the "Notifications blocked" pill exactly over
// the voice panel: at phone width it hid the listening state and the level
// meter for the whole of a push-to-talk hold, the one moment the user needs
// that feedback. So the inset is taken from the highest top edge among the
// composer and any of those overlays currently mounted, relative to the
// viewport bottom - which also stops assuming the composer's bottom edge IS the
// viewport bottom.
export const COMPOSER_OVERLAY_SELECTOR = ".wcv-panel, .cc-slashmenu, .cc-railmenu";

export interface EdgeRect { top: number; height: number }

export function composerInset(viewportHeight: number, composer: EdgeRect | null, overlays: readonly EdgeRect[] = []): number {
  if (!composer || composer.height <= 0) return 0;
  let top = composer.top;
  for (const o of overlays) {
    // An overlay with no box (display:none, mid-unmount) must not lift the pill.
    if (o.height > 0 && o.top < top) top = o.top;
  }
  return Math.max(0, Math.round(viewportHeight - top));
}
