#!/usr/bin/env node
// Bundle the Web Channel UI into ../dist/.
// Resolves react / react-dom / marked / @garrison/claude-chat from the Garrison
// root node_modules.

import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

// web-channel.css = base styles + the shared claude-chat stylesheet, so the
// single <link> in index.html covers both.
const baseCss = readFileSync(path.join(HERE, "styles.css"), "utf8");
const chatCssPath = path.resolve(HERE, "..", "..", "..", "..", "packages", "claude-chat", "src", "claude-chat.css");
let chatCss = "";
if (existsSync(chatCssPath)) {
  chatCss = readFileSync(chatCssPath, "utf8");
} else {
  // Installed-fitting layout: resolve via node_modules walk-up from repo root.
  try {
    const nm = path.resolve(HERE, "..", "..", "..", "..", "node_modules", "@garrison", "claude-chat", "src", "claude-chat.css");
    if (existsSync(nm)) chatCss = readFileSync(nm, "utf8");
  } catch { /* ignore */ }
}
writeFileSync(path.join(DIST, "web-channel.css"), `${baseCss}\n\n/* === @garrison/claude-chat === */\n${chatCss}\n`);

console.log("[web-channel:build] wrote dist/");
