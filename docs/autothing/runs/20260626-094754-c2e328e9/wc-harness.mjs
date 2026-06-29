// Reusable web-channel visual/behavior harness: a FAKE streaming gateway + the
// real web-channel server + a Playwright driver that screenshots states.
// Usage: node wc-harness.mjs <outDir>
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright";

const REPO = "/Users/ggomes/dev/garrison";
const SERVER = path.join(REPO, "fittings/seed/web-channel-default/scripts/server.mjs");
const OUT = process.argv[2] || "/tmp/wc-shots";

const STATUS = {
  mode: "bypassPermissions",
  rows: ["garrison | 12% | opus-4-8@high", "bypass permissions on (shift+tab to cycle)"],
  contextPct: 12,
  model: "claude-opus-4-8",
  busy: false,
};
const COMMANDS = [
  { name: "context", description: "Show token/context usage", source: "builtin" },
  { name: "review", description: "Review the current changes", source: "builtin" },
  { name: "summarize", description: "Summarise a document", source: "skill" },
];

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
    s.on("error", rej);
  });
}

// Fake gateway: holds the open SSE stream; on POST /claude/message it pushes a
// turn:active, streams an assistant reply (with a fenced code block) in chunks,
// then turn:inactive — exercising the working indicator + rich output.
function startGateway(port) {
  let stream = null;
  const REPLY = [
    "Here's a small `useDebouncedSave` hook. It autosaves after the field goes quiet for 600ms:\n\n",
    "```typescript\n",
    "// debounced autosave — fires 600ms after the last change\n",
    "export function useDebouncedSave(value, save) {\n",
    "  const t = useRef();\n",
    "  useEffect(() => {\n",
    "    if (t.current) clearTimeout(t.current);\n",
    "    t.current = setTimeout(() => save(value), 600);\n",
    "    return () => clearTimeout(t.current);\n",
    "  }, [value]);\n",
    "}\n",
    "```\n\n",
    "Drop it into the form and pass your `PATCH /api/settings` writer as `save`.",
  ];
  const srv = http.createServer((req, res) => {
    const u = req.url ?? "/";
    if (u === "/claude/status") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(STATUS)); }
    if (u === "/claude/commands") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ commands: COMMANDS })); }
    if (u === "/claude/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`event: hello\ndata: ${JSON.stringify({ mode: STATUS.mode, status: STATUS, busy: false, assistant: "", screen: ["welcome"] })}\n\n`);
      stream = res;
      req.on("close", () => { if (stream === res) stream = null; });
      return;
    }
    if (u === "/claude/message" && req.method === "POST") {
      res.setHeader("content-type", "application/json"); res.end("{}");
      if (!stream) return;
      const s = stream;
      let acc = "";
      s.write(`event: turn\ndata: ${JSON.stringify({ active: true })}\n\n`);
      s.write(`event: status\ndata: ${JSON.stringify({ rows: ["garrison | 12% | opus-4-8@high", "* Working… (esc to interrupt · 2.1k tokens)"], mode: STATUS.mode, contextPct: 12, model: STATUS.model })}\n\n`);
      let i = 0;
      const tick = () => {
        if (i < REPLY.length) {
          acc += REPLY[i++];
          s.write(`event: assistant\ndata: ${JSON.stringify({ text: acc })}\n\n`);
          setTimeout(tick, 140);
        } else {
          s.write(`event: turn\ndata: ${JSON.stringify({ active: false })}\n\n`);
        }
      };
      setTimeout(tick, 1200); // hold "Working" visible ~1.2s before first token
      return;
    }
    res.statusCode = 200; res.setHeader("content-type", "application/json"); res.end("{}");
  });
  srv.listen(port, "127.0.0.1");
  return srv;
}

async function waitHealth(port) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const gwPort = await freePort();
const wcPort = await freePort();
const gw = startGateway(gwPort);
const wc = spawn("node", [SERVER], {
  env: { ...process.env, GARRISON_GATEWAY_URL: `http://127.0.0.1:${gwPort}`, WEB_CHANNEL_PORT: String(wcPort), WEB_CHANNEL_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
wc.stderr.on("data", (d) => process.stderr.write(`[wc] ${d}`));
if (!(await waitHealth(wcPort))) { console.error("web-channel did not come up"); process.exit(1); }

const browser = await chromium.launch();
async function shot(name, w, h, drive) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${wcPort}/`);
  await page.waitForSelector(".cc-root");
  if (drive) await drive(page);
  await page.screenshot({ path: path.join(OUT, name) });
  await ctx.close();
}

// 1) empty state (desktop + mobile)
await shot("real-empty-mobile.png", 390, 844);
// 2) active conversation: send a message, capture mid-working then final
await shot("real-working-desktop.png", 820, 1000, async (page) => {
  await page.locator(".cc-input").fill("Add a debounced autosave to the settings form and show me the hook.");
  await page.locator(".cc-send").click();
  await page.waitForTimeout(700); // during the held "Working" window
});
await shot("real-final-desktop.png", 820, 1100, async (page) => {
  await page.locator(".cc-input").fill("Add a debounced autosave to the settings form and show me the hook.");
  await page.locator(".cc-send").click();
  await page.waitForSelector("text=Drop it into the form", { timeout: 8000 });
  await page.waitForTimeout(300);
});
await shot("real-final-mobile.png", 390, 1100, async (page) => {
  await page.locator(".cc-input").fill("Add a debounced autosave to the settings form and show me the hook.");
  await page.locator(".cc-send").click();
  await page.waitForSelector("text=Drop it into the form", { timeout: 8000 });
  await page.waitForTimeout(300);
});

// 3) Empty-state desktop (verify the refined empty hint) + a flow VIDEO.
await shot("real-empty-desktop.png", 900, 800);
const vctx = await browser.newContext({
  viewport: { width: 900, height: 1000 },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: 900, height: 1000 } },
});
const vpage = await vctx.newPage();
await vpage.goto(`http://127.0.0.1:${wcPort}/`);
await vpage.waitForSelector(".cc-root");
await vpage.waitForTimeout(900);
await vpage.locator(".cc-input").fill("Add a debounced autosave to the settings form and show me the hook.");
await vpage.waitForTimeout(500);
await vpage.locator(".cc-send").click();
await vpage.waitForSelector(".cc-working");
await vpage.waitForTimeout(900);
await vpage.waitForSelector("text=Drop it into the form", { timeout: 8000 });
await vpage.waitForTimeout(500);
await vpage.locator(".cc-codecopy").click();
await vpage.waitForTimeout(900);
const vpath = await vpage.video()?.path();
await vctx.close();
console.log("VIDEO ->", vpath);

await browser.close();
try { wc.kill("SIGTERM"); } catch {}
try { gw.close(); } catch {}
console.log("OK shots ->", OUT);
process.exit(0);
