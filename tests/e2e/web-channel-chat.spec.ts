import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";

// Deterministic UI smoke for the rich Claude chat (web-channel). Boots a FAKE
// gateway (canned /claude/* responses) + the web-channel server, then drives
// the page directly — no live claude, so it's fast and stable. Runs under the
// existing playwright projects (incl. the 390x844 mobile project).

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

function startFakeGateway(port: number): http.Server {
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
      // keep open
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
});
