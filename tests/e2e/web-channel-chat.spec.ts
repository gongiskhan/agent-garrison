import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";

// Deterministic UI smoke for the rich Claude chat (web-channel). Boots a FAKE
// gateway (canned /claude/* responses, incl. a STREAMED reply with a fenced code
// block) + the web-channel server, then drives the page directly — no live
// claude, so it's fast and stable. Runs under the existing playwright projects
// (incl. the 390x844 mobile project).

// Playwright transpiles specs to CJS, so use process.cwd() (it runs from the
// repo root) rather than import.meta.url.
const REPO_ROOT = process.cwd();
const WEB_CHANNEL = path.join(REPO_ROOT, "fittings", "seed", "web-channel-default", "scripts", "server.mjs");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const STATUS = {
  mode: "bypassPermissions",
  rows: ["myproj | 12% | Sonnet 4.6@high", "bypass permissions on (shift+tab to cycle)"],
  contextPct: 12,
  model: "Sonnet 4.6@high",
  busy: false,
};
const COMMANDS = [
  { name: "context", description: "Show token/context usage", source: "builtin" },
  { name: "review", description: "Review the current changes", source: "builtin" },
  { name: "summarize", description: "Summarise a document", source: "skill" },
  { name: "deploy", description: "Deploy to prod", source: "project" },
];

// The streamed assistant reply (sent in chunks on POST /claude/message). Carries
// a fenced TypeScript code block so the test can assert syntax highlighting +
// the per-block copy button.
const CODE_BODY = [
  "export function useDebouncedSave(value, save) {\n",
  "  const t = useRef();\n",
  "  return value;\n",
  "}",
].join("");
const REPLY_CHUNKS = [
  "Here's a `useDebouncedSave` hook:\n\n",
  // Annotated fence (info-string carries more than the language) — exercises the
  // first-token language extraction: the label must read "typescript", not the
  // whole info-string, and highlighting must still apply.
  '```typescript title="hook.ts"\n',
  CODE_BODY + "\n",
  "```\n\n",
  "Drop it into the form. <img src=x onerror=\"window.__xss=1\"> done.",
];

function startFakeGateway(port: number): http.Server {
  let stream: http.ServerResponse | null = null;
  const srv = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/claude/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(STATUS));
      return;
    }
    if (url === "/claude/commands") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ commands: COMMANDS }));
      return;
    }
    if (url === "/claude/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`event: hello\ndata: ${JSON.stringify({ mode: STATUS.mode, status: STATUS, busy: false, assistant: "", screen: ["welcome"] })}\n\n`);
      stream = res;
      req.on("close", () => { if (stream === res) stream = null; });
      return;
    }
    if (url === "/claude/message" && req.method === "POST") {
      res.setHeader("content-type", "application/json");
      res.end("{}");
      const s = stream;
      if (!s) return;
      let acc = "";
      // turn:active + a status row carrying an activity hint, then a deliberate
      // pause so the test can observe the "working" indicator before tokens.
      s.write(`event: turn\ndata: ${JSON.stringify({ active: true })}\n\n`);
      s.write(`event: status\ndata: ${JSON.stringify({ rows: ["myproj | 12% | Sonnet 4.6@high", "* Forging… (esc to interrupt · 2.1k tokens)"], mode: STATUS.mode, contextPct: 12, model: STATUS.model })}\n\n`);
      let i = 0;
      const tick = () => {
        if (!stream) return;
        if (i < REPLY_CHUNKS.length) {
          acc += REPLY_CHUNKS[i++];
          s.write(`event: assistant\ndata: ${JSON.stringify({ text: acc })}\n\n`);
          setTimeout(tick, 90);
        } else {
          s.write(`event: turn\ndata: ${JSON.stringify({ active: false })}\n\n`);
        }
      };
      setTimeout(tick, 1400); // hold "working" visible ~1.4s before first token
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  srv.listen(port, "127.0.0.1");
  return srv;
}

test.describe("web-channel rich chat UI", () => {
  // Clipboard assertions need write+read permission in the headless context.
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  let fake: http.Server;
  let wc: ChildProcess;
  let wcPort: number;

  test.beforeAll(async () => {
    const gwPort = await freePort();
    wcPort = await freePort();
    fake = startFakeGateway(gwPort);
    wc = spawn("node", [WEB_CHANNEL], {
      env: { ...process.env, GARRISON_GATEWAY_URL: `http://127.0.0.1:${gwPort}`, WEB_CHANNEL_PORT: String(wcPort), WEB_CHANNEL_HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // wait for web-channel health
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      try {
        const r = await fetch(`http://127.0.0.1:${wcPort}/api/health`);
        if (r.ok) break;
      } catch {
        /* not up */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  test.afterAll(() => {
    try { wc?.kill("SIGTERM"); } catch { /* ignore */ }
    try { fake?.close(); } catch { /* ignore */ }
  });

  test("renders chat shell, status strip, mode switcher, and slash menu", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${wcPort}/`);

    // Chat root + composer present.
    await expect(page.locator(".cc-root")).toBeVisible();
    await expect(page.locator(".cc-input")).toBeVisible();

    // Status strip shows the canned status line.
    await expect(page.locator(".cc-statusstrip")).toContainText("Sonnet 4.6@high");

    // Mode switcher renders the four modes; bypass is the active one.
    await expect(page.locator(".cc-mode", { hasText: "Plan" })).toBeVisible();
    await expect(page.locator(".cc-mode-active")).toContainText("Bypass");

    // Typing "/" opens the slash menu with the canned commands + descriptions.
    await page.locator(".cc-input").click();
    await page.locator(".cc-input").fill("/re");
    await expect(page.locator(".cc-slashmenu")).toBeVisible();
    await expect(page.locator(".cc-slashitem", { hasText: "review" })).toContainText("Review the current changes");

    // "/" with skill query shows the skill badge.
    await page.locator(".cc-input").fill("/sum");
    await expect(page.locator(".cc-slashitem", { hasText: "summarize" }).locator(".cc-badge-skill")).toBeVisible();
  });

  test("wears the Garrison skin (cream paper + serif title)", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${wcPort}/`);
    await expect(page.locator(".cc-root")).toBeVisible();

    // The web-channel skin re-points the component palette at Garrison "paper"
    // (#fbf8f1 = rgb(251, 248, 241)) — proving the override layer won, not the
    // shared dark default (#0d1117).
    const bg = await page.locator(".cc-root").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(251, 248, 241)");

    // Title is set in the Source Serif display face.
    const titleFont = await page.locator(".cc-title").evaluate((el) => getComputedStyle(el).fontFamily);
    expect(titleFont.toLowerCase()).toContain("source serif");
  });

  test("shows a working indicator, then highlights code with working copy buttons", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${wcPort}/`);
    await expect(page.locator(".cc-input")).toBeVisible();

    await page.locator(".cc-input").fill("Add a debounced autosave and show me the hook.");
    await page.locator(".cc-send").click();

    // 1) Working indicator: visible before the first token, with a live elapsed
    //    timer and the activity hint pulled from the PTY status line.
    const working = page.locator(".cc-working");
    await expect(working).toBeVisible();
    await expect(working.locator(".cc-working-label")).toHaveText("Working");
    await expect(working.locator(".cc-working-time")).toHaveText(/^\d+:\d\d$/);
    await expect(working.locator(".cc-working-hint")).toContainText("esc to interrupt");

    // 2) Once the stream completes, the fenced block is a rich code card with a
    //    language label and syntax highlighting (hljs token spans).
    const block = page.locator(".cc-codeblock");
    await expect(block).toBeVisible({ timeout: 8000 });
    await expect(block.locator(".cc-codelang")).toHaveText("typescript");
    await expect(block.locator(".hljs-keyword").first()).toBeVisible(); // export/function/const/return

    // The working indicator is gone now the reply has rendered.
    await expect(working).toHaveCount(0);

    // 3) Per-block copy button copies the code to the clipboard.
    const copyBtn = block.locator(".cc-codecopy");
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    await expect(copyBtn).toHaveText("Copied");
    const codeClip = await page.evaluate(() => navigator.clipboard.readText());
    expect(codeClip).toContain("useDebouncedSave");

    // 3b) Raw HTML in the assistant stream is escaped, not rendered as DOM
    //     (no injected <img>, no onerror side effect).
    await expect(page.locator(".cc-md img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    await expect(page.locator(".cc-md").last()).toContainText("<img src=x");

    // 4) Per-message copy button copies the whole assistant response.
    const msgCopy = page.locator(".cc-msgcopy").last();
    await expect(msgCopy).toBeVisible();
    await msgCopy.click();
    await expect(msgCopy).toHaveText("Copied");
    const msgClip = await page.evaluate(() => navigator.clipboard.readText());
    expect(msgClip).toContain("Drop it into the form");
  });
});
