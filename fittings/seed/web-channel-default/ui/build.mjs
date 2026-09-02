#!/usr/bin/env node
// Bundle the Web Channel UI into ../dist/.
// The application is @garrison/talk/ui (packages/talk/ui); main.tsx here is the
// mount. Resolves react / react-dom / marked / @garrison/* from the Garrison root
// node_modules by walk-up, which also covers the installed-fitting layout under
// compositions/<id>/apm_modules/_local/.

import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");
mkdirSync(DIST, { recursive: true });

// The talk package on disk, wherever node resolves it from (the workspace link
// in the checkout, the root node_modules for an installed copy).
const require = createRequire(import.meta.url);
const TALK_UI = path.dirname(require.resolve("@garrison/talk/ui"));
const { emitPwaAssets } = await import(url.pathToFileURL(path.join(TALK_UI, "pwa-assets.mjs")).href);

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

// web-channel.css = the shared claude-chat stylesheet FIRST, then the
// web-channel skin (styles.css) LAST, so the skin's Garrison palette/chrome
// overrides the component's dark default on equal specificity. Order matters:
// styles.css is the override layer and must win, so it is appended last.
const skinCss = readFileSync(path.join(TALK_UI, "styles.css"), "utf8");
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
// xterm.css (remote-shell terminal pane) — resolved by walk-up like the chat
// stylesheet; base layer, before the skin.
let xtermCss = "";
{
  let dir = HERE;
  for (let i = 0; i < 8 && dir !== path.dirname(dir); i++) {
    const candidate = path.join(dir, "node_modules", "@xterm", "xterm", "css", "xterm.css");
    if (existsSync(candidate)) { xtermCss = readFileSync(candidate, "utf8"); break; }
    dir = path.dirname(dir);
  }
  if (!xtermCss) console.warn("[web-channel:build] xterm.css not found walking up from", HERE);
}
writeFileSync(path.join(DIST, "web-channel.css"), `/* === @xterm/xterm (base) === */\n${xtermCss}\n\n/* === @garrison/claude-chat (base) === */\n${chatCss}\n\n/* === web-channel skin (override layer) === */\n${skinCss}\n`);

// PWA surface: manifest + service worker + generated icons (192/512/apple-touch
// + svg) into dist/. Generated here so the icons never drift from their source
// mark and no binary blobs are checked into the repo.
const pwaAssets = await emitPwaAssets({ srcDir: HERE, distDir: DIST });
console.log(`[web-channel:build] wrote ${pwaAssets.length} PWA asset(s) (manifest, sw, icons)`);

console.log("[web-channel:build] wrote dist/");
