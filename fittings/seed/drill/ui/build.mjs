#!/usr/bin/env node
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");
mkdirSync(DIST, { recursive: true });

await build({
  entryPoints: [path.join(HERE, "main.tsx")],
  bundle: true,
  format: "esm",
  outfile: path.join(DIST, "drill.bundle.js"),
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css" },
  jsx: "automatic",
  jsxDev: false,
  minify: false,
  sourcemap: true,
  target: ["es2022"],
  logLevel: "info"
});

// Picker vendor (D4): a self-contained IIFE — no import statements, no shared
// scope with drill.bundle.js — because its TEXT gets read server-side and
// injected into the APP-UNDER-TEST's page via CDP Runtime.evaluate, a plain
// classic-script context.
await build({
  entryPoints: [path.join(HERE, "picker-vendor.ts")],
  bundle: true,
  format: "iife",
  outfile: path.join(DIST, "picker-vendor.js"),
  loader: { ".ts": "ts" },
  minify: true,
  sourcemap: false,
  target: ["es2020"],
  logLevel: "info"
});

copyFileSync(path.join(HERE, "index.html"), path.join(DIST, "index.html"));
copyFileSync(path.join(HERE, "styles.css"), path.join(DIST, "drill.css"));

console.log("[drill:build] wrote dist/");
