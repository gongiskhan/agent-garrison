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
  outfile: path.join(DIST, "dev-env.bundle.js"),
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css" },
  jsx: "automatic",
  jsxDev: false,
  minify: false,
  sourcemap: true,
  target: ["es2022"],
  logLevel: "info"
});

copyFileSync(path.join(HERE, "index.html"), path.join(DIST, "index.html"));
copyFileSync(path.join(HERE, "styles.css"), path.join(DIST, "dev-env.css"));

// Copy xterm CSS so the UI can be served stand-alone without a CSS-in-JS
// pipeline. Walk up from here — the fitting may be built in-repo or from an
// apm_modules/_local install dir, so the hop count to node_modules varies.
let xtermCss = null;
let dir = HERE;
for (let i = 0; i < 8 && dir !== path.dirname(dir); i++) {
  const candidate = path.join(dir, "node_modules", "@xterm", "xterm", "css", "xterm.css");
  if (existsSync(candidate)) { xtermCss = candidate; break; }
  dir = path.dirname(dir);
}
if (xtermCss) {
  copyFileSync(xtermCss, path.join(DIST, "xterm.css"));
} else {
  console.warn("[dev-env:build] xterm.css not found walking up from", HERE);
}

console.log("[dev-env:build] wrote dist/");
