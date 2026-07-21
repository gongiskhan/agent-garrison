import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { waitExit } from "./helpers/wait-exit";

// Phase 8 (E1-E4) — Drill's own UI at phone width: FAB toggles the plan
// sheet; Highlight closes the sheet, picks on the full-screen canvas with
// enlarged touch targets, and reopens the sheet with the new area ready.

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const BROWSER_PORT = 7246;
const DRILL_PORT = 7247;
const BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-mobile-home-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-mobile-target-"));

let browserSrv: ChildProcess | null = null;
let drillSrv: ChildProcess | null = null;
let browser: Browser | null = null;
let page: Page | null = null;

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const FIXTURE_URL =
  "data:text/html," +
  encodeURIComponent(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<button data-testid="fixture-btn" style="position:absolute;top:100px;left:40px;width:160px;height:44px">Click me</button>'
  );

beforeAll(async () => {
  browserSrv = spawn("node", [BROWSER_START, "--port", String(BROWSER_PORT), "--host", "127.0.0.1"], {
    stdio: "ignore", env: { ...process.env, GARRISON_HOME: ghome }
  });
  expect(await waitHealthy(BROWSER_BASE, 15000)).toBe(true);

  drillSrv = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome, GARRISON_DRILL_TARGET_REPO: target, DRILL_UI_PORT: String(DRILL_PORT), DRILL_UI_HOST: "127.0.0.1" }
  });
  expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);

  await fetch(`${DRILL_BASE}/api/drillbook`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: { name: "f", url: FIXTURE_URL } }) });
  await fetch(`${DRILL_BASE}/api/pages/testpage`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Test page", path: "" }) });

  browser = await chromium.launch({ headless: true });
  // A real phone width/height + touch emulation, matching the mock's phone frame.
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
}, 30000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  if (browserSrv && !browserSrv.killed) browserSrv.kill("SIGTERM");
  await waitExit(browserSrv);
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  browserSrv = null; drillSrv = null;
    rmSync(ghome, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
}, 15000);

describe("Drill's own UI at phone width", () => {
  it("the FAB toggles the plan sheet open and closed", async () => {
    const p = page!;
    await p.goto(DRILL_BASE);
    await p.getByRole("tab", { name: "Authoring" }).click();
    await p.locator(".dr-cv").waitFor({ state: "visible", timeout: 15000 });

    // Browser-first: the plan starts closed so the app is visible.
    await p.locator(".dr-au-plan.dr-sheet-closed").waitFor({ timeout: 15000 });
    await p.locator(".dr-fab").waitFor({ state: "visible", timeout: 15000 });
    await p.locator(".dr-cv-live").waitFor({ state: "visible", timeout: 15000 });

    // The FAB opens the plan and its close control returns to the browser.
    await p.locator(".dr-fab").click();
    await p.locator(".dr-au-plan.dr-sheet-open").waitFor({ timeout: 15000 });
    await p.locator(".dr-sheet-close").click();
    await p.locator(".dr-au-plan.dr-sheet-closed").waitFor({ timeout: 15000 });
    await p.locator(".dr-fab").waitFor({ state: "visible", timeout: 15000 });
  }, 90000);

  it("Highlight closes the sheet, picks with a touch tap on the full-screen canvas, and reopens the sheet with the new area", async () => {
    const p = page!;
    await p.goto(`${DRILL_BASE}/?view=authoring&page=testpage`);
    await p.locator(".dr-cv").waitFor({ state: "visible", timeout: 15000 });
    // Select the "mobile" device/viewport chip for the APP UNDER TEST too —
    // independent of Drill's own responsive UI, but it makes the canvas a
    // phone-shaped box, matching this test's coordinate math.
    await p.locator(".dr-au-canvas").getByText("mobile", { exact: true }).click();
    await p.locator(".dr-cv").waitFor({ state: "visible", timeout: 10000 });
    await p.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>(".dr-cv-frame");
      return !!image?.complete && image.naturalWidth > 0;
    });
    expect(await p.locator(".dr-cv-frame").evaluate((image: HTMLImageElement) => [
      image.naturalWidth,
      image.naturalHeight
    ])).toEqual([390, 844]);
    // Open the plan explicitly, then use its Highlight action. It closes the
    // sheet and enters pick mode on the unobstructed browser.
    await p.locator(".dr-fab").click();
    await p.locator(".dr-au-plan.dr-sheet-open").waitFor({ timeout: 15000 });
    await p.locator(".dr-au-plan").getByRole("button", { name: /Highlight an area/i }).click();

    // The sheet closed automatically (E2) so the canvas is reachable.
    await p.locator(".dr-au-plan.dr-sheet-closed").waitFor({ timeout: 15000 });
    await p.getByText(/Click the element you want Drill to track/i).waitFor({ timeout: 15000 });

    const overlay = p.locator(".dr-cv-overlay");
    const box = await overlay.boundingBox();
    expect(box).toBeTruthy();
    expect(Math.abs((box!.width / box!.height) - (390 / 844))).toBeLessThan(0.01);
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(391);
    expect(box!.y + box!.height).toBeLessThanOrEqual(845);
    // Fixture button center: top:100 left:40 width:160 height:44 -> (120, 122)
    // in an (assumed) 390x844-ish authoring viewport — click proportionally.
    const targetX = box!.x + (120 / 390) * box!.width;
    const targetY = box!.y + (122 / 844) * box!.height;
    await p.touchscreen.tap(targetX, targetY);

    // Badge renders AND the sheet reopened with the new area ready.
    await p.locator(".dr-abox").waitFor({ state: "visible", timeout: 10000 });
    await p.locator(".dr-au-plan.dr-sheet-open").waitFor({ timeout: 15000 });
    const areaName = p.getByRole("textbox", { name: "Area 1 name" });
    await areaName.waitFor({ timeout: 15000 });
    expect(await areaName.inputValue()).toBe("fixture-btn");
    const settledCanvas = await p.locator(".dr-cv").boundingBox();
    const area = await p.locator(".dr-abox").boundingBox();
    expect(settledCanvas).toBeTruthy();
    expect(area).toBeTruthy();
    expect(Math.abs(area!.x - (settledCanvas!.x + (40 / 390) * settledCanvas!.width))).toBeLessThan(3);
    expect(Math.abs(area!.y - (settledCanvas!.y + (100 / 844) * settledCanvas!.height))).toBeLessThan(3);
  }, 90000);
});
