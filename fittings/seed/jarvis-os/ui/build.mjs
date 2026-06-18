#!/usr/bin/env node
// Bundle the Jarvis HUD UI into ../dist/. Resolves react / react-dom from the
// Garrison root node_modules (same pattern as web-channel). No three.js — the
// DitherCore is WebGL2-only, so the bundle stays light.

import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");
mkdirSync(DIST, { recursive: true });

await build({
  entryPoints: [path.join(HERE, "main.tsx")],
  bundle: true,
  format: "esm",
  outfile: path.join(DIST, "jarvis.bundle.js"),
  loader: { ".tsx": "tsx", ".ts": "ts" },
  jsx: "automatic",
  jsxDev: false,
  minify: true,
  sourcemap: false,
  target: ["es2022"],
  // ReportOverlay reads NEXT_PUBLIC_OBSIDIAN_VAULT (a Fable Next.js inline). In
  // a Garrison HUD there is no Obsidian vault, so define it empty (hides the
  // deep link) and avoid a `process is not defined` at runtime.
  define: { "process.env.NEXT_PUBLIC_OBSIDIAN_VAULT": '""' },
  logLevel: "info"
});

copyFileSync(path.join(HERE, "index.html"), path.join(DIST, "index.html"));
writeFileSync(path.join(DIST, "jarvis.css"), readFileSync(path.join(HERE, "styles.css"), "utf8"));

console.log("[jarvis-os:build] wrote dist/");
