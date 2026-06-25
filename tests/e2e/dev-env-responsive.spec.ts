import { test, expect } from "@playwright/test";
import http from "node:http";
import net from "node:net";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Deterministic UI test for the responsive dev-env shell (slice: responsive-panes).
// Serves the BUILT dev-env bundle (fittings/seed/dev-env/dist) and stubs the
// endpoints the UI polls with a single canned session AND a working browser
// target, so the browser pane mounts a REAL <iframe> (not just its empty shell).
// Mirrors the web-channel-chat fake-gateway pattern. Drives the real React app
// at three widths to prove the 720px breakpoint behaviour:
//   - desktop (1400 / 820 > 720): the side-by-side split is intact (terminals-col
//     + split-divider + browser-pane-host with a live iframe), no mobile tabs
//   - mobile  (390  <= 720):      a 3-way Claude | Shell | Browser tab switcher;
//     exactly one of terminals-col / browser-pane-host visible at a time; the
//     Browser tab reveals the pane with a real iframe; switching tabs does NOT
//     remount the iframe (same element survives, no second browser-tab open);
//     no horizontal overflow at 390px.
// Self-contained: navigates to its own stub server by absolute URL (ignores the
// playwright baseURL), so it does not depend on the Garrison Next app.

const REPO_ROOT = process.cwd();
const DIST = path.join(REPO_ROOT, "fittings", "seed", "dev-env", "dist");

const CANNED_SESSION = {
  id: "e2e-sess-1",
  branch: "main",
  worktreePath: "/tmp/devenv-e2e-proj",
  projectName: "devenv-e2e",
  projectPath: "/tmp/devenv-e2e-proj",
  lastStatus: "idle",
  lastStatusAt: new Date().toISOString(),
  claudeSessionId: null,
  title: "devenv-e2e",
  source: "test",
  dirty: false,
  isWorktree: false,
  external: false,
  openedInDevEnv: true,
  claudeClosed: false,
  claudePty: { state: "none" },
  terminals: [],
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

// A real (empty) canvas page so the iframe genuinely loads + fires onLoad.
const CANVAS_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><title>canvas</title></head><body data-canvas=\"1\"></body></html>";

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

function serveStatic(res: http.ServerResponse, file: string): boolean {
  const full = path.join(DIST, file);
  if (!full.startsWith(DIST) || !existsSync(full)) return false;
  const ext = path.extname(full);
  res.setHeader("content-type", CONTENT_TYPES[ext] ?? "application/octet-stream");
  res.setHeader("cache-control", "no-store");
  res.end(readFileSync(full));
  return true;
}

// Counts how many times the UI opened a browser-fitting tab — a second tab-open
// after the first wire would mean the iframe was remounted / re-attached.
type Stub = { server: http.Server; base: string; tabOpens: () => number; reset: () => void };

async function startStub(): Promise<Stub> {
  const port = await freePort();
  let tabOpens = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const p = u.pathname;
    const method = req.method ?? "GET";
    const json = (code: number, body: unknown) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(body));
    };

    // Session list -> one canned session so the workspace renders.
    if (p === "/sessions") return json(200, { sessions: [CANNED_SESSION] });
    if (p === "/health") return json(200, { ok: true, fittingId: "dev-env", port, tmux: false, ptys: 0 });
    // app.port present -> the desktop browser pane (+ its split divider) appears,
    // and BrowserPane can resolve an app URL on every viewport.
    if (p === "/app-port") return json(200, { port: 4321 });
    // Tailscale + browser-target resolve so BrowserPane mounts a real iframe
    // pointing back at this stub's /canvas/<tabId>.
    if (p === "/tailscale-ip") return json(200, { ip: "127.0.0.1" });
    if (p === "/browser-target") return json(200, { url: `http://127.0.0.1:${port}`, port });
    // Browser-fitting tab API (subset BrowserPane calls).
    if (p === "/tabs" && method === "POST") { tabOpens += 1; return json(200, { tabId: "tab-e2e-1" }); }
    if (/^\/tabs\/[^/]+\/nav$/.test(p) && method === "POST") return json(200, { ok: true });
    if (/^\/canvas\//.test(p)) {
      res.setHeader("content-type", CONTENT_TYPES[".html"]);
      res.setHeader("cache-control", "no-store");
      return res.end(CANVAS_HTML);
    }
    if (p === "/settings/excludes") return json(200, { patterns: [], defaults: [] });
    if (p === "/dev-root") return json(200, { root: "/tmp" });
    if (p === "/projects") return json(200, { projects: [] });

    // Static bundle.
    if (p === "/" || p === "/index.html") {
      if (serveStatic(res, "index.html")) return;
    } else if (serveStatic(res, p.replace(/^\//, ""))) {
      return;
    }

    // Default: empty JSON so any other poll resolves without error.
    return json(200, {});
  });
  server.listen(port, "127.0.0.1");
  return { server, base: `http://127.0.0.1:${port}`, tabOpens: () => tabOpens, reset: () => { tabOpens = 0; } };
}

test.describe("dev-env responsive shell", () => {
  let stub: Stub;

  test.beforeAll(async () => {
    expect(existsSync(path.join(DIST, "dev-env.bundle.js")), "dev-env dist must be built (node ui/build.mjs)").toBe(true);
    stub = await startStub();
  });

  test.afterAll(() => {
    try { stub?.server.close(); } catch { /* ignore */ }
  });

  // Reset the per-test page to the canned width BEFORE first paint so the
  // matchMedia(max-width:720px) listener renders the right layout immediately.
  async function open(page: import("@playwright/test").Page, width: number, height = 900) {
    await page.setViewportSize({ width, height });
    await page.goto(`${stub.base}/`);
    await expect(page.locator(".workspace")).toBeVisible();
  }

  const paneSwitch = '.segmented[aria-label="Pane"]';

  test("desktop 1400px: side-by-side split intact (live iframe), no mobile tab switcher", async ({ page }) => {
    await open(page, 1400);
    await expect(page.locator(".terminals-col")).toBeVisible();
    await expect(page.locator(".split-divider")).toBeVisible();
    await expect(page.locator(".browser-pane-host")).toBeVisible();
    // The pane really wired a real iframe (not just the empty shell).
    await expect(page.locator(".app-iframe")).toBeVisible();
    await expect(page.locator(".app-iframe")).toHaveAttribute("src", /\/canvas\//);
    // The mobile pane switcher is isMobile-only -> absent on desktop.
    await expect(page.locator(paneSwitch)).toHaveCount(0);
  });

  test("820px (just above the 720 breakpoint): still the desktop split", async ({ page }) => {
    await open(page, 820);
    await expect(page.locator(".terminals-col")).toBeVisible();
    await expect(page.locator(".split-divider")).toBeVisible();
    await expect(page.locator(".browser-pane-host")).toBeVisible();
    await expect(page.locator(paneSwitch)).toHaveCount(0);
  });

  test("mobile 390px: 3-way switcher; panes toggle; browser iframe reachable AND not remounted", async ({ page }) => {
    // This test counts browser-tab opens; reset the shared stub counter so the
    // earlier desktop page-loads don't bleed into the assertion.
    stub.reset();
    await open(page, 390, 844);

    // The 3-way segmented switcher is present with all three tabs.
    const sw = page.locator(paneSwitch);
    await expect(sw).toBeVisible();
    await expect(sw.getByRole("tab", { name: "Claude" })).toBeVisible();
    await expect(sw.getByRole("tab", { name: "Shell" })).toBeVisible();
    await expect(sw.getByRole("tab", { name: "Browser" })).toBeVisible();

    // No desktop divider on mobile.
    await expect(page.locator(".split-divider")).toHaveCount(0);

    // Default tab = Claude: terminals column visible, browser pane hidden — but
    // the browser pane is MOUNTED (iframe attached) so it can persist.
    await expect(page.locator(".terminals-col")).toBeVisible();
    await expect(page.locator(".browser-pane-host")).toBeHidden();
    const iframe = page.locator(".app-iframe");
    await expect(iframe).toBeAttached();
    await expect(iframe).toHaveAttribute("src", /\/canvas\//);
    const src1 = await iframe.getAttribute("src");

    // Tag the live iframe element. A React remount would create a NEW element
    // that does NOT carry this marker.
    await iframe.evaluate((el) => el.setAttribute("data-persist-probe", "v1"));

    // Switch to Browser: pane becomes visible, terminals column hides.
    // (Regression of the old "browser hidden on mobile" behaviour.)
    await sw.getByRole("tab", { name: "Browser" }).click();
    await expect(page.locator(".browser-pane-host")).toBeVisible();
    await expect(page.locator(".terminals-col")).toBeHidden();
    await expect(iframe).toBeVisible();

    // Round-trip Claude -> Browser to exercise tab switching.
    await sw.getByRole("tab", { name: "Claude" }).click();
    await expect(page.locator(".terminals-col")).toBeVisible();
    await expect(page.locator(".browser-pane-host")).toBeHidden();
    await sw.getByRole("tab", { name: "Browser" }).click();
    await expect(page.locator(".browser-pane-host")).toBeVisible();

    // The SAME iframe element survived (display-toggled, not unmounted): the
    // marker is still there and the src is unchanged.
    const probe = await page.locator(".app-iframe").getAttribute("data-persist-probe");
    expect(probe).toBe("v1");
    expect(await page.locator(".app-iframe").getAttribute("src")).toBe(src1);

    // And the browser-fitting tab was opened exactly once across all the
    // switching — no second open/attach cycle (would indicate a remount).
    // (stub runs in this Node process, so its counter is read directly.)
    expect(stub.tabOpens()).toBe(1);

    // No horizontal page overflow at 390px.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
