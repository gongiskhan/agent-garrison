#!/usr/bin/env node
// Generates this node's branded icons into $GARRISON_HOME/branding/.
//
// The shipped mark (public/icons/icon.svg) is a detailed 512px illustration
// with named gradients. Recolouring it wholesale stops it looking like
// Garrison, so instead we add a NODE BAND: a solid accent bar across the
// bottom edge carrying a one- or two-letter monogram. The band's colour is
// what reads in a 16px tab strip; the monogram is what reads in a dock.
//
// Rasterisation uses the Chromium the repo already depends on through
// @playwright/test. Deliberately no `sharp`: an install-time script must not
// add a native dependency to the tree.
//
// Run: node scripts/node-branding.mjs [--out <dir>] [--source <icon.svg>]
//
// The palette and monogram rules are duplicated from src/lib/node-identity.ts
// because this script must run standalone under plain `node`, which cannot
// import TypeScript. tests/node-identity.test.ts imports both and asserts they
// agree, so the copies cannot drift.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

export const NODE_ACCENTS = [
  { id: "moss", hex: "#4a7d5f", ink: "#ffffff" },
  { id: "fern", hex: "#478529", ink: "#ffffff" },
  { id: "brass", hex: "#85763a", ink: "#ffffff" },
  { id: "copper", hex: "#a26949", ink: "#ffffff" },
  { id: "rose", hex: "#a7626b", ink: "#ffffff" },
  { id: "plum", hex: "#af5895", ink: "#ffffff" },
  { id: "violet", hex: "#8a62a7", ink: "#ffffff" },
  { id: "steel", hex: "#527c91", ink: "#ffffff" }
];

// The PNG sizes the manifest, the apple-touch tag and the favicon ask for.
export const ICON_SIZES = [
  { file: "node-512.png", size: 512 },
  { file: "node-192.png", size: 192 },
  { file: "node-180.png", size: 180 },
  { file: "node-32.png", size: 32 },
  { file: "node-16.png", size: 16 }
];

export function garrisonHome() {
  const override = process.env.GARRISON_HOME?.trim();
  return override || path.join(os.homedir(), ".garrison");
}

export function sanitizeNodeId(raw) {
  if (typeof raw !== "string") return null;
  const label = raw.trim().toLowerCase().split(".")[0] ?? "";
  const cleaned = label
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return cleaned || null;
}

function hashString(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function accentForNodeId(id) {
  return NODE_ACCENTS[hashString(id) % NODE_ACCENTS.length];
}

export function resolveAccent(value, id) {
  if (typeof value === "number" && Number.isInteger(value) && NODE_ACCENTS[value]) {
    return NODE_ACCENTS[value];
  }
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    const found = NODE_ACCENTS.find((a) => a.id === key || a.hex === key);
    if (found) return found;
  }
  return accentForNodeId(id);
}

export function nodeMonogram(name) {
  const words = String(name ?? "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const single = (words[0] ?? "").toUpperCase();
  if (single.length >= 2) return single.slice(0, 2);
  if (single.length === 1) return single;
  return "GN";
}

// Same degradation as readNodeIdentity(): an absent or malformed node.json
// still yields a distinct node rather than an error.
export function readIdentity(home = garrisonHome()) {
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(home, "node.json"), "utf8"));
  } catch {
    doc = null;
  }
  const rec = doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  const id = sanitizeNodeId(rec.id) ?? sanitizeNodeId(os.hostname()) ?? "node";
  const accent = resolveAccent(rec.accent, id);
  const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
  return { id, name, accent };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The band sits exactly where the shipped mark's dark earthwork band already
// is (y=392, 120 tall of 512), so it replaces a flat area rather than covering
// the palisade. Rounded top corners keep it from reading as a crop.
export function bandedSvg(sourceSvg, { hex, ink, monogram }) {
  const y = 392;
  const h = 120;
  const r = 18;
  const band = [
    '  <!-- Node band: this machine\'s accent + monogram (scripts/node-branding.mjs) -->',
    '  <g class="node-band">',
    `    <path d="M0 ${y + r} A ${r} ${r} 0 0 1 ${r} ${y} H ${512 - r} A ${r} ${r} 0 0 1 512 ${y + r} V 512 H 0 Z" fill="${hex}"/>`,
    `    <rect x="${r}" y="${y}" width="${512 - r * 2}" height="3" fill="rgba(255,255,255,0.20)"/>`,
    `    <text x="256" y="${y + h / 2 + 2}" text-anchor="middle" dominant-baseline="central"`,
    `      font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="76" font-weight="700"`,
    `      fill="${ink}">${escapeXml(monogram)}</text>`,
    "  </g>"
  ].join("\n");
  const close = sourceSvg.lastIndexOf("</svg>");
  if (close < 0) throw new Error("source icon is not an <svg> document");
  return `${sourceSvg.slice(0, close)}${band}\n${sourceSvg.slice(close)}`;
}

async function rasterize(svg, outDir) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const { file, size } of ICON_SIZES) {
      // The SVG is inlined rather than loaded as a data: URL so there is no
      // load race to wait on - setContent resolves once it is parsed.
      const sized = svg.replace(
        /<svg([^>]*)\swidth="\d+"\sheight="\d+"/,
        `<svg$1 width="${size}" height="${size}"`
      );
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${sized}</body></html>`,
        { waitUntil: "load" }
      );
      const png = await page.screenshot({ omitBackground: true });
      fs.writeFileSync(path.join(outDir, file), png);
    }
  } finally {
    await browser.close();
  }
}

async function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const home = flag("--home") ?? garrisonHome();
  const outDir = flag("--out") ?? path.join(home, "branding");
  const source = flag("--source") ?? path.join(REPO_ROOT, "public", "icons", "icon.svg");

  const identity = readIdentity(home);
  const monogram = nodeMonogram(identity.name);
  const svg = bandedSvg(fs.readFileSync(source, "utf8"), {
    hex: identity.accent.hex,
    ink: identity.accent.ink,
    monogram
  });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "node.svg"), svg);
  await rasterize(svg, outDir);

  console.log(
    `[node-branding] ${identity.name} (${identity.id}) accent=${identity.accent.id} ${identity.accent.hex} monogram=${monogram}`
  );
  console.log(`[node-branding] wrote node.svg + ${ICON_SIZES.length} PNGs to ${outDir}`);
}

// Main-guard so the test suite can import the palette and the SVG builder
// without launching a browser.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((err) => {
    console.error(`[node-branding] failed: ${err?.message ?? err}`);
    process.exit(1);
  });
}
