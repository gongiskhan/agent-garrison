import { test, expect } from "@playwright/test";
import http from "node:http";
import net from "node:net";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Deterministic UI test for the browser-pane device-viewport selector
// (slice: browser-viewport-selector). Serves the BUILT dev-env bundle + stubs
// the endpoints so the browser pane mounts a real iframe, then drives the
// Desktop / Tablet / Mobile selector and asserts the embedded app is rendered
// at a FIXED device width (it does NOT fluid-fit the pane) for tablet/mobile,
// and fluid for desktop. Mirrors the dev-env-responsive fake-server pattern.

const REPO_ROOT = process.cwd();
const DIST = path.join(REPO_ROOT, "fittings", "seed", "dev-env", "dist");

const CANNED_SESSION = {
  id: "e2e-vp-1", branch: "main",
  worktreePath: "/tmp/devenv-vp-proj", projectName: "devenv-vp",
  projectPath: "/tmp/devenv-vp-proj", lastStatus: "idle",
  lastStatusAt: new Date().toISOString(), claudeSessionId: null,
  title: "devenv-vp", source: "test", dirty: false,
  isWorktree: false, external: false, openedInDevEnv: true,
  claudeClosed: false, claudePty: { state: "none" }, terminals: [],
};
const CT: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".map": "application/json; charset=utf-8",
};
const CANVAS = "<!doctype html><html><head><meta charset=\"utf-8\"><title>canvas</title></head><body data-canvas=\"1\"></body></html>";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const p = typeof a === "object" && a ? a.port : 0;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}
function serveStatic(res: http.ServerResponse, file: string): boolean {
  const full = path.join(DIST, file);
  if (!full.startsWith(DIST) || !existsSync(full)) return false;
  res.setHeader("content-type", CT[path.extname(full)] ?? "application/octet-stream");
  res.setHeader("cache-control", "no-store");
  res.end(readFileSync(full));
  return true;
}
async function startStub(): Promise<{ server: http.Server; base: string }> {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const p = u.pathname, m = req.method ?? "GET";
    const json = (c: number, b: unknown) => { res.statusCode = c; res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); res.end(JSON.stringify(b)); };
    if (p === "/sessions") return json(200, { sessions: [CANNED_SESSION] });
    if (p === "/health") return json(200, { ok: true });
    if (p === "/app-port") return json(200, { port: 4321 });
    if (p === "/tailscale-ip") return json(200, { ip: "127.0.0.1" });
    if (p === "/browser-target") return json(200, { url: `http://127.0.0.1:${port}`, port });
    if (p === "/tabs" && m === "POST") return json(200, { tabId: "tab-vp-1" });
    if (/^\/tabs\/[^/]+\/nav$/.test(p) && m === "POST") return json(200, { ok: true });
    if (/^\/canvas\//.test(p)) { res.setHeader("content-type", CT[".html"]); res.setHeader("cache-control", "no-store"); return res.end(CANVAS); }
    if (p === "/settings/excludes") return json(200, { patterns: [], defaults: [] });
    if (p === "/dev-root") return json(200, { root: "/tmp" });
    if (p === "/projects") return json(200, { projects: [] });
    if (p === "/" || p === "/index.html") { if (serveStatic(res, "index.html")) return; }
    else if (serveStatic(res, p.replace(/^\//, ""))) return;
    return json(200, {});
  });
  server.listen(port, "127.0.0.1");
  return { server, base: `http://127.0.0.1:${port}` };
}

const sel = '.device-selector';

test.describe("dev-env browser-pane device viewport", () => {
  let stub: { server: http.Server; base: string };

  test.beforeAll(async () => {
    expect(existsSync(path.join(DIST, "dev-env.bundle.js")), "dev-env dist must be built").toBe(true);
    stub = await startStub();
  });
  test.afterAll(() => { try { stub?.server.close(); } catch { /* ignore */ } });

  async function openDesktop(page: import("@playwright/test").Page) {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${stub.base}/`);
    await expect(page.locator(".browser-pane-host")).toBeVisible();
    await expect(page.locator(".app-iframe")).toBeVisible(); // real iframe wired
  }
  async function iframeWidth(page: import("@playwright/test").Page): Promise<number> {
    const box = await page.locator(".app-iframe").boundingBox();
    return box?.width ?? -1;
  }
  async function viewportWidth(page: import("@playwright/test").Page): Promise<number> {
    const box = await page.locator(".app-pane-viewport").boundingBox();
    return box?.width ?? -1;
  }
  // Fluid == the iframe fills its container; this is what distinguishes a real
  // desktop layout from one stuck at a fixed device width (820/390).
  async function expectFluid(page: import("@playwright/test").Page) {
    const cw = await viewportWidth(page);
    const iw = await iframeWidth(page);
    expect(cw).toBeGreaterThan(400); // a real, non-trivial pane
    // Fluid == iframe fills its container. A layout stuck at a fixed device
    // width (820/390) would NOT equal the ~697px split pane, so this fails it.
    expect(Math.abs(iw - cw)).toBeLessThanOrEqual(2);
  }

  test("selector present with 3 options; default Desktop is fluid", async ({ page }) => {
    await openDesktop(page);
    const s = page.locator(sel);
    await expect(s).toBeVisible();
    await expect(s.getByRole("button", { name: "Desktop" })).toBeVisible();
    await expect(s.getByRole("button", { name: "Tablet" })).toBeVisible();
    await expect(s.getByRole("button", { name: "Mobile" })).toBeVisible();
    // Desktop is the default + active, iframe fills the pane (fluid == container width).
    await expect(s.getByRole("button", { name: "Desktop" })).toHaveClass(/on/);
    await expect(page.locator(".app-pane-viewport")).toHaveClass(/device-desktop/);
    await expectFluid(page);
  });

  test("Mobile -> fixed 390px; Tablet -> fixed 820px; Desktop -> fluid", async ({ page }) => {
    await openDesktop(page);
    const s = page.locator(sel);

    await s.getByRole("button", { name: "Mobile" }).click();
    await expect(page.locator(".app-pane-viewport")).toHaveClass(/device-mobile/);
    expect(await iframeWidth(page)).toBeGreaterThan(388);
    expect(await iframeWidth(page)).toBeLessThan(392);

    await s.getByRole("button", { name: "Tablet" }).click();
    await expect(page.locator(".app-pane-viewport")).toHaveClass(/device-tablet/);
    expect(await iframeWidth(page)).toBeGreaterThan(818);
    expect(await iframeWidth(page)).toBeLessThan(822);

    await s.getByRole("button", { name: "Desktop" }).click();
    await expect(page.locator(".app-pane-viewport")).toHaveClass(/device-desktop/);
    await expectFluid(page); // fluid again == iframe fills container (not a stuck 820/390)
  });

  test("choice persists across reload (localStorage)", async ({ page }) => {
    await openDesktop(page);
    await page.locator(sel).getByRole("button", { name: "Mobile" }).click();
    await expect(page.locator(".app-pane-viewport")).toHaveClass(/device-mobile/);
    // reload — same context keeps localStorage
    await page.reload();
    await expect(page.locator(".app-iframe")).toBeVisible();
    await expect(page.locator(".app-pane-viewport")).toHaveClass(/device-mobile/);
    await expect(page.locator(sel).getByRole("button", { name: "Mobile" })).toHaveClass(/on/);
    expect(await iframeWidth(page)).toBeLessThan(392);
  });

  test("selector is also present inside the mobile Browser tab", async ({ page }) => {
    // localStorage is fresh per test -> device defaults back to desktop.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${stub.base}/`);
    await expect(page.locator(".workspace")).toBeVisible();
    await page.locator('.segmented[aria-label="Pane"]').getByRole("tab", { name: "Browser" }).click();
    await expect(page.locator(".browser-pane-host")).toBeVisible();
    await expect(page.locator(sel)).toBeVisible();
    await expect(page.locator(sel).getByRole("button", { name: "Tablet" })).toBeVisible();
  });
});
