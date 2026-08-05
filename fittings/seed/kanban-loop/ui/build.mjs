#!/usr/bin/env node
// Bundle the Kanban Loop board UI into ../dist/. Resolves react / react-dom from
// the Garrison root node_modules (this fitting has no package.json of its own —
// same as web-channel / dev-env). Modeled on web-channel-default/ui/build.mjs.

import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
// SessionStream is the same shared component Web Channel renders. Ship its base
// stylesheet first, then the Kanban skin so local palette/chrome overrides win.
const skinCss = readFileSync(path.join(HERE, "styles.css"), "utf8");
const chatCssPath = path.resolve(HERE, "..", "..", "..", "..", "packages", "claude-chat", "src", "claude-chat.css");
let chatCss = "";
if (existsSync(chatCssPath)) {
  chatCss = readFileSync(chatCssPath, "utf8");
} else {
  const nm = path.resolve(HERE, "..", "..", "..", "..", "node_modules", "@garrison", "claude-chat", "src", "claude-chat.css");
  if (existsSync(nm)) chatCss = readFileSync(nm, "utf8");
}
writeFileSync(
  path.join(DIST, "kanban.css"),
  `/* === @garrison/claude-chat (base) === */\n${chatCss.trimEnd()}\n\n/* === kanban skin (override layer) === */\n${skinCss.trimEnd()}\n`
);

// Copy xterm's CSS so the Terminal modal's xterm renders correctly when served
// stand-alone. Walk up from here — the fitting may be built in-repo or from an
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
  console.warn("[kanban-loop:build] xterm.css not found walking up from", HERE);
}

console.log("[kanban-loop:build] wrote dist/");
