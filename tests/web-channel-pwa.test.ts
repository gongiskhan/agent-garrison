// S6c — Web Channel PWA installability.
//
// Pins the installable-PWA surface without a browser:
//   1. manifest.json is valid JSON with the required installability fields and
//      192 + 512 PNG icons.
//   2. sw.js parses (build/syntax check) and never intercepts the live API surface.
//   3. emitPwaAssets() emits manifest + sw + icons into dist/ — with real, decodable
//      PNG icons of the right dimensions and an actually-drawn (two-colour) mark.
//   4. Installability contract: index.html links the manifest + apple-touch-icon and
//      registers the service worker; the manifest's icons resolve to emitted files.
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
// @ts-ignore — plain .mjs, typed via tests/web-channel-mjs.d.ts
import { emitPwaAssets, renderIconPng, iconSvg, PWA_DIST_ASSETS } from "../fittings/seed/web-channel-default/ui/pwa-assets.mjs";

const UI_DIR = fileURLToPath(new URL("../fittings/seed/web-channel-default/ui", import.meta.url));

const readUi = (name: string) => readFileSync(path.join(UI_DIR, name), "utf8");

// Minimal PNG reader: signature + IHDR dimensions + concatenated IDAT pixels
// (our encoder uses filter 0 on every scanline, so the inflated stream is
// [filterByte, ...rgba] per row). Enough to prove the icon is a real image.
function decodePng(buf: Buffer) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("bad PNG signature");
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return { width, height, raw };
}

// Distinct RGB triples sampled from a filter-0 RGBA raster.
function sampleColors({ width, raw }: { width: number; raw: Buffer }): Set<string> {
  const stride = width * 4 + 1; // +1 filter byte per scanline
  const colors = new Set<string>();
  for (let y = 0; y < raw.length / stride; y += 8) {
    const rowStart = y * stride + 1;
    for (let x = 0; x < width; x += 8) {
      const p = rowStart + x * 4;
      colors.add(`${raw[p]},${raw[p + 1]},${raw[p + 2]}`);
    }
  }
  return colors;
}

describe("web-channel PWA — manifest", () => {
  const manifest = JSON.parse(readUi("manifest.json"));

  it("is valid JSON with the required installability fields", () => {
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(typeof manifest.short_name).toBe("string");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(manifest.background_color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(Array.isArray(manifest.icons)).toBe(true);
  });

  it("declares 192 + 512 PNG icons", () => {
    const png = manifest.icons.filter((i: { type?: string }) => i.type === "image/png");
    const sizes = png.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    for (const icon of png) {
      expect(typeof icon.src).toBe("string");
      expect(icon.src.startsWith("/")).toBe(true);
    }
  });
});

describe("web-channel PWA — service worker", () => {
  const sw = readUi("sw.js");

  it("parses as valid JS (build/syntax check)", () => {
    // vm.Script compiles (parses) without executing — SW globals (self/caches) are
    // never touched, so a SyntaxError is the only way this throws.
    expect(() => new vm.Script(sw, { filename: "sw.js" })).not.toThrow();
  });

  it("wires the install/activate/fetch lifecycle", () => {
    expect(sw).toContain('addEventListener("install"');
    expect(sw).toContain('addEventListener("activate"');
    expect(sw).toContain('addEventListener("fetch"');
  });

  it("never intercepts the live API surface (SSE + voice WS proxies)", () => {
    // The bypass guard must exempt /api/*, non-GET, cross-origin, and event-streams
    // so the chat stream and the voice WebSockets are untouched.
    expect(sw).toContain('/api/');
    expect(sw).toContain("text/event-stream");
    expect(sw).toMatch(/method !== "GET"/);
    expect(sw).toContain("self.location.origin");
  });
});

describe("web-channel PWA — build emits assets", () => {
  it("emitPwaAssets writes manifest + sw + icons into dist/", async () => {
    const dist = mkdtempSync(path.join(tmpdir(), "wc-pwa-"));
    const written = await emitPwaAssets({ srcDir: UI_DIR, distDir: dist });
    for (const rel of PWA_DIST_ASSETS) {
      const abs = path.join(dist, rel);
      expect(existsSync(abs), `missing emitted asset ${rel}`).toBe(true);
    }
    // Returned list matches the declared contract.
    expect(written.length).toBe(PWA_DIST_ASSETS.length);
    // The copied manifest matches the source.
    expect(readFileSync(path.join(dist, "manifest.json"), "utf8")).toBe(readUi("manifest.json"));
  });

  it("generates decodable PNG icons at the declared sizes", () => {
    for (const size of [192, 512, 180]) {
      const { width, height } = decodePng(renderIconPng(size));
      expect(width).toBe(size);
      expect(height).toBe(size);
    }
  });

  it("actually draws the mark (icon has both background and foreground colours)", () => {
    const png = decodePng(renderIconPng(192));
    const colors = sampleColors(png);
    // A blank square would yield a single colour; the drawn "G" yields many
    // (ink, cream, and the anti-aliased blend between them).
    expect(colors.size).toBeGreaterThan(3);
  });

  it("emits a well-formed SVG twin", () => {
    const svg = iconSvg(512);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    expect(svg).toContain('viewBox="0 0 512 512"');
  });
});

describe("web-channel PWA — installability contract", () => {
  const html = readUi("index.html");
  const manifest = JSON.parse(readUi("manifest.json"));

  it("index.html links the manifest, apple-touch-icon, and registers the SW", () => {
    expect(html).toMatch(/<link[^>]+rel="manifest"[^>]+href="\/manifest\.json"/);
    expect(html).toMatch(/rel="apple-touch-icon"/);
    expect(html).toContain('serviceWorker');
    expect(html).toContain('register("/sw.js")');
    // SW registration must be gated on a secure context (https/localhost).
    expect(html).toContain("isSecureContext");
  });

  it("every manifest icon src resolves to an emitted dist asset", async () => {
    const dist = mkdtempSync(path.join(tmpdir(), "wc-pwa-"));
    await emitPwaAssets({ srcDir: UI_DIR, distDir: dist });
    for (const icon of manifest.icons as Array<{ src: string }>) {
      const abs = path.join(dist, icon.src.replace(/^\//, ""));
      expect(existsSync(abs), `manifest icon ${icon.src} not emitted`).toBe(true);
    }
  });
});
