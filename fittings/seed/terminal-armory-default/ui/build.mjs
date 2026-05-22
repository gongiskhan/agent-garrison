#!/usr/bin/env node
import { build } from "esbuild";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");
mkdirSync(DIST, { recursive: true });

await build({
  entryPoints: [path.join(HERE, "main.tsx")],
  bundle: true,
  format: "esm",
  outfile: path.join(DIST, "terminal.bundle.js"),
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css" },
  jsx: "automatic",
  jsxDev: false,
  minify: false,
  sourcemap: true,
  target: ["es2022"],
  logLevel: "info"
});

copyFileSync(path.join(HERE, "index.html"), path.join(DIST, "index.html"));
copyFileSync(path.join(HERE, "styles.css"), path.join(DIST, "terminal.css"));

// Copy xterm CSS so the UI can be served stand-alone without a CSS-in-JS pipeline.
const xtermCssCandidates = [
  path.resolve(HERE, "..", "..", "..", "..", "node_modules", "@xterm", "xterm", "css", "xterm.css"),
  path.resolve(HERE, "..", "node_modules", "@xterm", "xterm", "css", "xterm.css")
];
const xtermCss = xtermCssCandidates.find((p) => existsSync(p));
if (xtermCss) {
  copyFileSync(xtermCss, path.join(DIST, "xterm.css"));
} else {
  console.warn("[terminal:build] xterm.css not found in", xtermCssCandidates);
}

console.log("[terminal:build] wrote dist/");
