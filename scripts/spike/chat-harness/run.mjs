import { build } from "esbuild";
import http from "node:http";
import path from "node:path";
import url from "node:url";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { chromium } from "playwright";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const EVID = path.resolve(HERE, "..", "..", "..", "docs", "autothing", "evidence", "refit");
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: [path.join(HERE, "app.tsx")],
  bundle: true,
  format: "esm",
  outfile: path.join(OUT, "app.js"),
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css" },
  jsx: "automatic",
  jsxDev: false,
  minify: false,
  target: ["es2022"],
  logLevel: "warning"
});

writeFileSync(
  path.join(OUT, "index.html"),
  `<!doctype html><html><head><meta charset="utf8"><link rel="stylesheet" href="/app.css">
   <style>html,body,#root{height:100%;margin:0}</style></head>
   <body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`
);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const server = http.createServer((req, res) => {
  const u = url.parse(req.url || "/").pathname || "/";
  if (u === "/voice/health") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ available: true, url: "http://127.0.0.1:7085", keyConfigured: true }));
  }
  if (u === "/voice/tts" || u === "/voice/stt") {
    res.statusCode = 200;
    res.setHeader("content-type", u.endsWith("tts") ? "audio/mpeg" : "application/json");
    return res.end(u.endsWith("tts") ? Buffer.alloc(0) : JSON.stringify({ transcript: "", confidence: 0 }));
  }
  const file = path.join(OUT, u === "/" ? "index.html" : u.replace(/^\/+/, ""));
  if (!file.startsWith(OUT) || !existsSync(file)) {
    res.statusCode = 404;
    return res.end("nf");
  }
  res.setHeader("content-type", MIME[path.extname(file)] ?? "application/octet-stream");
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(4319, "127.0.0.1", r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 760, height: 760 } });

// dark (default)
await page.goto("http://127.0.0.1:4319/", { waitUntil: "load" });
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(EVID, "s5-chat-dark.png") });
const toolbar = await page.evaluate(() => {
  const tb = document.querySelector(".cc-toolbar");
  return tb ? tb.textContent : "(no .cc-toolbar)";
});
console.log("TOOLBAR(dark): " + JSON.stringify(toolbar));
const theme = await page.evaluate(() => document.querySelector(".cc-root")?.getAttribute("data-theme"));
console.log("data-theme(dark default): " + theme);

// light
await page.evaluate(() => localStorage.setItem("garrison.devenv.termTheme", "light"));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(900);
const themeL = await page.evaluate(() => document.querySelector(".cc-root")?.getAttribute("data-theme"));
console.log("data-theme(after light): " + themeL);
await page.screenshot({ path: path.join(EVID, "s5-chat-light.png") });

await browser.close();
server.close();
console.log("done");
