// PWA asset generation for the Web Channel — dependency-free.
//
// Emits the installable-PWA surface into dist/:
//   - icons/icon-192.png, icons/icon-512.png  (manifest icons, purpose "any maskable")
//   - icons/apple-touch-icon-180.png          (iOS home-screen icon)
//   - icons/icon.svg                          (crisp vector favicon / master)
//   - manifest.json, sw.js                    (copied verbatim from ui/)
//
// The icons are RASTERISED here (no image toolchain, no binary blobs checked in):
// a pure-Node PNG encoder + a supersampled rasteriser draw the Garrison "G" mark
// so the build stays reproducible and the icons never drift from the source mark.
// build.mjs calls emitPwaAssets(); the PWA tests import the same functions.

import zlib from "node:zlib";
import { promises as fs } from "node:fs";
import path from "node:path";

// Garrison palette (mirrors ui/styles.css): ink background, cream mark.
const INK = [24, 33, 28]; // #18211c
const CREAM = [251, 248, 241]; // #fbf8f1

// Mark geometry, in icon-normalised [0,1] coordinates. Everything sits inside the
// inner 80% "safe zone" (radius < 0.4 from centre) so ONE icon set is valid as
// both "any" and "maskable" — no separate maskable files needed.
const CENTER = 0.5;
const RING_OUTER = 0.31;
const RING_INNER = 0.205;
// Opening of the "G": a wedge cut from the RIGHT of the ring, centred due east,
// so the ring reads as a "C". Angles are in radians with +y pointing DOWN (image
// coords), 0 = due east.
const GAP_FROM = -0.42;
const GAP_TO = 0.42;
// The horizontal tongue/crossbar (the "G" spur) — a short stroke sitting in the
// opening at mid-height, which is what turns the "C" into a "G".
const BAR_HALF_H = 0.047;
const BAR_FROM_X = 0.5;
const BAR_TO_X = 0.5 + RING_OUTER;

// True when (u,v) falls on the drawn mark. Pure geometry, sampled per sub-pixel.
function insideMark(u, v) {
  const dx = u - CENTER;
  const dy = v - CENTER;
  const r = Math.hypot(dx, dy);
  const onRingBand = r >= RING_INNER && r <= RING_OUTER;
  if (onRingBand) {
    const ang = Math.atan2(dy, dx);
    const inGap = ang > GAP_FROM && ang < GAP_TO;
    if (!inGap) return true;
  }
  // Crossbar / tongue.
  if (v >= CENTER - BAR_HALF_H && v <= CENTER + BAR_HALF_H && u >= BAR_FROM_X && u <= BAR_TO_X) {
    return true;
  }
  return false;
}

// ── Pure-Node PNG encoder (8-bit RGBA, single IDAT, filter 0) ────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // ihdr[10..12] = 0 (deflate / adaptive filtering / no interlace)
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// Render the Garrison "G" emblem to a size×size PNG Buffer. 4×4 supersampling
// anti-aliases the mark edges against the ink background.
export function renderIconPng(size) {
  const SS = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (insideMark(u, v)) hits++;
        }
      }
      const t = hits / (SS * SS); // mark coverage 0..1
      const idx = (y * size + x) * 4;
      rgba[idx] = Math.round(INK[0] + (CREAM[0] - INK[0]) * t);
      rgba[idx + 1] = Math.round(INK[1] + (CREAM[1] - INK[1]) * t);
      rgba[idx + 2] = Math.round(INK[2] + (CREAM[2] - INK[2]) * t);
      rgba[idx + 3] = 255; // full-bleed opaque (correct for maskable + iOS)
    }
  }
  return encodePng(size, size, rgba);
}

// Crisp vector twin of the raster mark — a ring with a lower-right opening plus a
// tongue, drawn with the SAME geometry constants so it never drifts from the PNGs.
export function iconSvg(size = 512) {
  const hex = (c) => "#" + c.map((n) => n.toString(16).padStart(2, "0")).join("");
  const rMid = ((RING_INNER + RING_OUTER) / 2) * size;
  const strokeW = (RING_OUTER - RING_INNER) * size;
  const cx = CENTER * size;
  const cy = CENTER * size;
  // Ring arc from GAP_TO around to GAP_FROM (the drawn part, i.e. skipping the gap).
  const a0 = GAP_TO;
  const a1 = GAP_FROM + Math.PI * 2; // sweep the long way round, past the gap
  const p0 = [cx + rMid * Math.cos(a0), cy + rMid * Math.sin(a0)];
  const p1 = [cx + rMid * Math.cos(a1), cy + rMid * Math.sin(a1)];
  const arc = `M ${p0[0].toFixed(2)} ${p0[1].toFixed(2)} A ${rMid.toFixed(2)} ${rMid.toFixed(2)} 0 1 1 ${p1[0].toFixed(2)} ${p1[1].toFixed(2)}`;
  const barY = CENTER * size;
  const barX1 = BAR_FROM_X * size;
  const barX2 = BAR_TO_X * size;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${hex(INK)}"/>
  <path d="${arc}" fill="none" stroke="${hex(CREAM)}" stroke-width="${strokeW.toFixed(2)}" stroke-linecap="round"/>
  <line x1="${barX1.toFixed(2)}" y1="${barY.toFixed(2)}" x2="${barX2.toFixed(2)}" y2="${barY.toFixed(2)}" stroke="${hex(CREAM)}" stroke-width="${(BAR_HALF_H * 2 * size).toFixed(2)}" stroke-linecap="round"/>
</svg>
`;
}

// dist-relative paths of every asset emitPwaAssets() produces — the installability
// contract the tests assert against.
export const PWA_DIST_ASSETS = [
  "manifest.json",
  "sw.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon-180.png",
  "icons/icon.svg"
];

// Generate icons + copy the static PWA source files (manifest.json, sw.js) into
// dist/. srcDir is the ui/ dir that holds the source manifest + service worker.
export async function emitPwaAssets({ srcDir, distDir }) {
  const written = [];
  const iconsDir = path.join(distDir, "icons");
  await fs.mkdir(iconsDir, { recursive: true });

  const pngs = [
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["apple-touch-icon-180.png", 180]
  ];
  for (const [name, sz] of pngs) {
    const p = path.join(iconsDir, name);
    await fs.writeFile(p, renderIconPng(sz));
    written.push(p);
  }
  const svgPath = path.join(iconsDir, "icon.svg");
  await fs.writeFile(svgPath, iconSvg(512), "utf8");
  written.push(svgPath);

  for (const name of ["manifest.json", "sw.js"]) {
    const to = path.join(distDir, name);
    await fs.copyFile(path.join(srcDir, name), to);
    written.push(to);
  }
  return written;
}
