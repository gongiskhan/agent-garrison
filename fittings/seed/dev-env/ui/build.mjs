#!/usr/bin/env node
import { build } from "esbuild";
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

// dev-env.css = base styles + the shared claude-chat stylesheet (for the rich
// Chat view), so the single <link> in index.html covers both.
{
  const baseCss = readFileSync(path.join(HERE, "styles.css"), "utf8");
  let chatCss = "";
  let d = HERE;
  for (let i = 0; i < 8 && d !== path.dirname(d); i++) {
    const inRepo = path.join(d, "packages", "claude-chat", "src", "claude-chat.css");
    const inNm = path.join(d, "node_modules", "@garrison", "claude-chat", "src", "claude-chat.css");
    if (existsSync(inRepo)) { chatCss = readFileSync(inRepo, "utf8"); break; }
    if (existsSync(inNm)) { chatCss = readFileSync(inNm, "utf8"); break; }
    d = path.dirname(d);
  }
  writeFileSync(path.join(DIST, "dev-env.css"), `${baseCss}\n\n/* === @garrison/claude-chat === */\n${chatCss}\n`);
}

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
