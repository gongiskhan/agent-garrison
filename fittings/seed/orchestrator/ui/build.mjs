#!/usr/bin/env node
// Bundle the Model Router view into ../dist/. routing-core.mjs is pure (no node
// imports) so it bundles into the browser — the Compiled pane + manual simulator
// resolve client-side (deterministic, no live model).
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
  outfile: path.join(DIST, "main.js"),
  loader: { ".tsx": "tsx", ".ts": "ts" },
  jsx: "automatic",
  jsxDev: false,
  minify: false,
  sourcemap: true,
  target: ["es2022"],
  logLevel: "info"
});

copyFileSync(path.join(HERE, "index.html"), path.join(DIST, "index.html"));
copyFileSync(path.join(HERE, "styles.css"), path.join(DIST, "styles.css"));

console.log("[orchestrator:build] wrote dist/");
