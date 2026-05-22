#!/usr/bin/env node
// Bundle the Web Channel UI into ../dist/.
// Resolves react / react-dom / marked from the Garrison root node_modules.

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
  outfile: path.join(DIST, "web-channel.bundle.js"),
  loader: { ".tsx": "tsx", ".ts": "ts" },
  jsx: "automatic",
  jsxDev: false,
  minify: true,
  sourcemap: false,
  target: ["es2022"],
  logLevel: "info"
});

copyFileSync(path.join(HERE, "index.html"), path.join(DIST, "index.html"));
copyFileSync(path.join(HERE, "styles.css"), path.join(DIST, "web-channel.css"));

console.log("[web-channel:build] wrote dist/");
