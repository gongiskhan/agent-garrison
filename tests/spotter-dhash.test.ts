// Spotter pure functions (Drill Evidence V2, S1): the perceptual hash, its
// decoders (via playwright-core's utilsBundle — the loud-failure contract for
// playwright upgrades), and config clamping.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

// @ts-ignore — pure ESM .mjs, no .d.ts
import {
  spotterDecodersAvailable,
  decodeImage,
  dHash,
  dHashRgba,
  hamming,
  mergeSpotterConfig,
  SPOTTER_DEFAULTS
  // @ts-ignore
} from "../fittings/seed/browser-default/scripts/spotter.mjs";

const require_ = createRequire(__filename);
const { PNG, jpegjs } = require_("playwright-core/lib/utilsBundle");

function makeImage(width: number, height: number, paint: (x: number, y: number) => number) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const v = paint(x, y);
      png.data[idx] = v;
      png.data[idx + 1] = v;
      png.data[idx + 2] = v;
      png.data[idx + 3] = 255;
    }
  }
  return png;
}

describe("spotter decoders (playwright utilsBundle contract)", () => {
  it("exposes PNG + jpegjs — a playwright upgrade that drops them must fail HERE, loudly", () => {
    expect(spotterDecodersAvailable()).toBe(true);
    expect(typeof PNG).toBe("function");
    expect(typeof jpegjs.decode).toBe("function");
  });

  it("decodes PNG and JPEG buffers and rejects garbage", () => {
    const img = makeImage(32, 32, (x) => (x < 16 ? 0 : 255));
    const pngBuf = PNG.sync.write(img);
    const jpgBuf = jpegjs.encode({ data: img.data, width: 32, height: 32 }, 90).data;
    expect(decodeImage(pngBuf)).toMatchObject({ width: 32, height: 32 });
    expect(decodeImage(jpgBuf)).toMatchObject({ width: 32, height: 32 });
    expect(decodeImage(Buffer.from("not an image at all"))).toBeNull();
    expect(decodeImage(Buffer.from([0x89, 0x50, 1, 2, 3, 4, 5, 6]))).toBeNull();
  });
});

describe("dHash + hamming", () => {
  it("is stable across PNG/JPEG encodings of the same image", () => {
    const img = makeImage(64, 64, (x, y) => ((x >> 3) + (y >> 3)) % 2 ? 230 : 20);
    const fromPng = dHash(PNG.sync.write(img));
    const fromJpg = dHash(jpegjs.encode({ data: img.data, width: 64, height: 64 }, 85).data);
    expect(fromPng).not.toBeNull();
    expect(hamming(fromPng, fromJpg)).toBeLessThanOrEqual(2);
  });

  it("separates visually different frames well past the trigger threshold", () => {
    const a = makeImage(64, 64, (x) => (x < 32 ? 0 : 255));
    const b = makeImage(64, 64, (x) => (x < 32 ? 255 : 0));
    const ha = dHashRgba(a.data, 64, 64);
    const hb = dHashRgba(b.data, 64, 64);
    expect(hamming(ha, hb)).toBeGreaterThan(SPOTTER_DEFAULTS.phashThreshold);
    expect(hamming(ha, ha)).toBe(0);
  });

  it("detects full-width band changes (the horizontal-only dHash blind spot)", () => {
    // A page section flipping colour changes NO left-vs-right relation inside
    // its rows — a pure horizontal dHash scores it near zero. The vertical
    // gradient half must catch it (regression for the flip-fixture bug).
    const white = makeImage(64, 64, () => 255);
    const banded = makeImage(64, 64, (_x, y) => (y >= 16 && y < 48 ? 0 : 255));
    const dist = hamming(dHashRgba(white.data, 64, 64), dHashRgba(banded.data, 64, 64));
    expect(dist).toBeGreaterThan(SPOTTER_DEFAULTS.phashThreshold);
  });

  it("tolerates small perturbations (near-duplicates stay inside dedupe range)", () => {
    const base = makeImage(64, 64, (x, y) => Math.round((x + y) * 2));
    const wiggle = makeImage(64, 64, (x, y) => Math.min(255, Math.round((x + y) * 2) + 3));
    const hBase = dHashRgba(base.data, 64, 64);
    const hWiggle = dHashRgba(wiggle.data, 64, 64);
    expect(hamming(hBase, hWiggle)).toBeLessThanOrEqual(SPOTTER_DEFAULTS.dedupeDistance);
  });
});

describe("mergeSpotterConfig", () => {
  it("fills defaults and clamps hostile values", () => {
    const cfg = mergeSpotterConfig({
      sampleMs: 1,
      phashThreshold: 9999,
      dedupeDistance: -5,
      console: { lines: 0, windowMs: 1e9 },
      messageRegion: { selector: ".msg", growth: 0 },
      maxFrames: 1e9,
      screencast: { quality: 500 }
    });
    expect(cfg.sampleMs).toBe(100);
    expect(cfg.phashThreshold).toBe(144);
    expect(cfg.dedupeDistance).toBe(0);
    expect(cfg.console.lines).toBe(1);
    expect(cfg.console.windowMs).toBe(60_000);
    expect(cfg.messageRegion).toEqual({ selector: ".msg", growth: 1 });
    expect(cfg.maxFrames).toBe(2000);
    expect(cfg.screencast.quality).toBe(95);
  });

  it("defaults messageRegion off and survives junk input", () => {
    expect(mergeSpotterConfig(undefined).messageRegion).toBeNull();
    expect(mergeSpotterConfig({ messageRegion: { selector: 42 } }).messageRegion).toBeNull();
    expect(mergeSpotterConfig("garbage" as any)).toMatchObject({ sampleMs: SPOTTER_DEFAULTS.sampleMs });
  });
});
