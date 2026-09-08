import { test, expect } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { GARRISON_SANDBOX } from "./sandbox";

// G6: own-port Fitting views inside the app. A phone BROWSER opens them in a
// new tab (the iframe beside the rail is cramped); the app has no tabs, so there
// every own-port row embeds at /embed/<id>, which at phone width has no rail:
// the shell's app bar carries Back, the Fitting's name and Menu. The fake own-port view
// below stands in for a running fitting: the shell only knows a view through
// its ~/.garrison/ui-fittings/<id>.json status file and a /health probe.

const FITTING = "kanban-loop";

function installNativeStub(page: import("@playwright/test").Page) {
  return page.addInitScript(() => {
    const resolve = (value: unknown) => () => Promise.resolve(value);
    const events = () => ({ addListener: () => Promise.resolve({ remove: () => Promise.resolve() }) });
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        GarrisonNode: {
          current: resolve({ name: "sim", shellOrigin: location.origin, captureBaseURL: location.origin, hasToken: true }),
          list: resolve({ nodes: [] }),
          info: resolve({ appVersion: "1.0", build: "0", platform: "ios", bundleId: "test" }),
          ...events()
        },
        GarrisonCapture: {
          status: resolve({ phase: "idle", ackedFrames: 0, broadcasting: false, microphone: "undetermined", consentSuppressed: false }),
          ...events()
        },
        GarrisonPush: {
          status: resolve({ authorization: "notDetermined", registered: false, detail: "" }),
          pendingRoute: resolve({}),
          ...events()
        },
        GarrisonPendant: { status: resolve({ connectionState: "disconnected", paired: false, lostFrames: 0, ambientConsent: false, uploaderState: "idle" }), ...events() }
      }
    };
  });
}

let server: http.Server;
let statusFile: string;

test.beforeAll(async ({ request }) => {
  // The runner's one-shot orphan sweep (reconcileOrphanedOwnPortFittings, fired
  // by the first /api/runner/<id>/state read of a server process) SIGTERMs the
  // pid named in any own-port status file whose composition is not running.
  // Trigger it before the fake status file exists so it has nothing to reap,
  // and never name a live pid in that file: the sweep once killed this very
  // worker mid-test and Playwright reported it as a browser closed early.
  await request.get("/api/runner/default/state");
  await new Promise((done) => setTimeout(done, 1500));
  server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>fake view</title><h1 id=\"fake-view\">Fake own-port view</h1>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const dir = path.join(GARRISON_SANDBOX, "ui-fittings");
  fs.mkdirSync(dir, { recursive: true });
  statusFile = path.join(dir, `${FITTING}.json`);
  fs.writeFileSync(
    statusFile,
    JSON.stringify({ fittingId: FITTING, port, url: `http://127.0.0.1:${port}`, pid: null, startedAt: new Date().toISOString() })
  );
});

test.afterAll(async () => {
  fs.rmSync(statusFile, { force: true });
  // The shell's health probes keep connections alive; close() alone would wait
  // on them past the hook timeout and tear the worker down under the next test.
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

// Phone width starts with the menu drawer closed and the Fittings group folded.
async function openFittingsGroup(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Open menu" }).click();
  const group = page.getByRole("button", { name: /^Fittings/ });
  if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
}

// The mobile project is Desktop Chrome at 390px, so gate on the viewport, not
// the isMobile fixture (NARROW_BREAKPOINT in AppShell is 720).
const phoneWidth = (page: import("@playwright/test").Page) => (page.viewportSize()?.width ?? 1440) < 720;

test("phone browser: a live own-port row opens in a new tab", async ({ page }) => {
  test.skip(!phoneWidth(page), "phone-width behaviour");
  await page.goto("/");
  await openFittingsGroup(page);
  const row = page.locator(`.side a.item`, { hasText: "Kanban" }).first();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("target", "_blank");
});

test("app at phone width: the row embeds and the app bar carries Back", async ({ page }) => {
  test.skip(!phoneWidth(page), "phone-width behaviour");
  await installNativeStub(page);
  await page.goto("/");
  await openFittingsGroup(page);
  const row = page.locator(`.side a.item[href="/embed/${FITTING}"]`);
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute("target", "_blank");
  // The row's right edge carries the mobile pin toggle; tap the label.
  await row.locator("> span").first().click();
  await expect(page).toHaveURL(new RegExp(`/embed/${FITTING}$`));
  const bar = page.getByTestId("app-bar");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("Kanban");
  // No rail at phone width: the iframe has the whole width.
  await expect(page.locator(".side-rail")).toHaveCount(0);
  const frame = page.frameLocator(`iframe[title="${FITTING}"]`);
  await expect(frame.locator("#fake-view")).toBeVisible();
  const width = await page.locator(`iframe[title="${FITTING}"]`).evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 1);
  // Menu opens the drawer; Back leaves the view.
  await bar.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("dialog", { name: "Garrison menu" })).toBeVisible();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await bar.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("desktop: the embedded view keeps the sidebar and shows no app bar", async ({ page }) => {
  test.skip(phoneWidth(page), "desktop behaviour");
  await installNativeStub(page);
  await page.goto(`/embed/${FITTING}`);
  const frame = page.frameLocator(`iframe[title="${FITTING}"]`);
  await expect(frame.locator("#fake-view")).toBeVisible();
  await expect(page.getByTestId("app-bar")).toHaveCount(0);
  await expect(page.locator(".side")).toBeVisible();
});
