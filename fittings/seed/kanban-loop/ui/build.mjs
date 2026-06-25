#!/usr/bin/env node
// Bundle the Kanban Loop board UI into ../dist/. Resolves react / react-dom from
// the Garrison root node_modules (this fitting has no package.json of its own —
// same as web-channel / dev-env). Modeled on web-channel-default/ui/build.mjs.

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
  outfile: path.join(DIST, "kanban.bundle.js"),
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css" },
  jsx: "automatic",
  jsxDev: false,
  minify: true,
  sourcemap: false,
  target: ["es2022"],
  logLevel: "info"
});

copyFileSync(path.join(HERE, "index.html"), path.join(DIST, "index.html"));
writeFileSync(path.join(DIST, "kanban.css"), readFileSync(path.join(HERE, "styles.css"), "utf8"));

console.log("[kanban-loop:build] wrote dist/");
