// The push pills ride above the composer by --wc-composer-inset. That offset
// must clear everything the composer floats above itself - the voice panel
// during a push-to-talk hold, the slash menu, the rail flight menu - not only
// the composer's own box, or the pill lands on the listening state.
import { describe, it, expect } from "vitest";
import { composerInset, COMPOSER_OVERLAY_SELECTOR } from "../packages/talk/ui/composer-inset";

const VIEWPORT = 844;

describe("composerInset", () => {
  it("is zero with no composer mounted", () => {
    expect(composerInset(VIEWPORT, null)).toBe(0);
    expect(composerInset(VIEWPORT, { top: 800, height: 0 })).toBe(0);
  });

  it("clears the composer's own box when nothing floats above it", () => {
    // Composer 60px tall, flush with the viewport bottom.
    expect(composerInset(VIEWPORT, { top: 784, height: 60 })).toBe(60);
    // A composer whose bottom is NOT the viewport bottom (padding, safe area)
    // still gets a pill above its top edge, not merely its own height up.
    expect(composerInset(VIEWPORT, { top: 764, height: 60 })).toBe(80);
  });

  it("lifts the pill above the voice panel while it is up", () => {
    const composer = { top: 784, height: 60 };
    const voicePanel = { top: 700, height: 78 };
    expect(composerInset(VIEWPORT, composer, [voicePanel])).toBe(144);
  });

  it("takes the highest overlay when several are mounted", () => {
    const composer = { top: 784, height: 60 };
    expect(composerInset(VIEWPORT, composer, [
      { top: 700, height: 78 },
      { top: 420, height: 360 },
    ])).toBe(424);
  });

  it("ignores an overlay with no box", () => {
    const composer = { top: 784, height: 60 };
    expect(composerInset(VIEWPORT, composer, [{ top: 0, height: 0 }])).toBe(60);
  });

  it("names the three overlays anchored to the composer's top edge", () => {
    for (const cls of ["wcv-panel", "cc-slashmenu", "cc-railmenu"]) {
      expect(COMPOSER_OVERLAY_SELECTOR).toContain(`.${cls}`);
    }
  });
});
