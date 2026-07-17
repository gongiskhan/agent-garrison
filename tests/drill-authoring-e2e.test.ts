import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

// Authoring surface, real UI (Phase 3 non-negotiable test items 1 + 2): drives
// Drill's OWN React app in a real headless browser (not just its HTTP API) to
// prove the picker + step CRUD actually work end to end — click "Highlight
// new area" on the live canvas, verify a badge renders and an area persists;
// add/toggle/remove a step and verify it persists through a reload.

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const BROWSER_PORT = 7192;
const DRILL_PORT = 7193;
const BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-auth-e2e-home-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-auth-e2e-target-"));

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

// Fixture: a single clearly-testid'd button at a known position within the
// desktop viewport (1280x800) so the overlay-click math is checkable.
const FIXTURE_URL =
  "data:text/html," +
  encodeURIComponent(
    '<div style="width:100%;height:100%;position:relative;background:#fff">' +
      '<button data-testid="fixture-btn" style="position:absolute;top:100px;left:100px;width:160px;height:44px">Click me</button>' +
      "</div>"
  );

beforeAll(async () => {
  browserSrv = spawn("node", [BROWSER_START, "--port", String(BROWSER_PORT), "--host", "127.0.0.1"], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome }
  });
  expect(await waitHealthy(BROWSER_BASE, 15000)).toBe(true);

  drillSrv = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome, GARRISON_DRILL_TARGET_REPO: target, DRILL_UI_PORT: String(DRILL_PORT), DRILL_UI_HOST: "127.0.0.1" }
  });
  expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);

  await fetch(`${DRILL_BASE}/api/drillbook`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: { name: "fixture", url: FIXTURE_URL } })
  });
  await fetch(`${DRILL_BASE}/api/pages/testpage`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Test page", path: "" })
  });

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
}, 30000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  if (browserSrv && !browserSrv.killed) browserSrv.kill("SIGTERM");
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  browserSrv = null;
  drillSrv = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
}, 15000);

describe("Authoring surface — real UI", () => {
  it("picks an element on the live canvas and renders a badge; the area persists", async () => {
    const p = page!;
    await p.goto(DRILL_BASE);
    await p.getByRole("button", { name: "Authoring" }).click();
    await p.locator(".dr-cv").waitFor({ state: "visible", timeout: 15000 });

    await p.getByRole("button", { name: /Highlight new area/i }).click();
    await p.getByText("Now click an element in the preview…").waitFor({ timeout: 5000 });

    // Click the overlay at the point corresponding to the fixture button's
    // center (top:100 left:100 width:160 height:44 in a 1280x800 viewport).
    const overlay = p.locator(".dr-cv-overlay");
    const box = await overlay.boundingBox();
    expect(box).toBeTruthy();
    const targetX = box!.x + (180 / 1280) * box!.width;
    const targetY = box!.y + (122 / 800) * box!.height;
    await p.mouse.click(targetX, targetY);

    await p.locator(".dr-abox").waitFor({ state: "visible", timeout: 10000 });
    expect(await p.locator(".dr-abadge").textContent()).toBe("1");

    const pageDoc = await (await fetch(`${DRILL_BASE}/api/pages/testpage`)).json();
    expect(pageDoc.page.areas).toHaveLength(1);
    expect(pageDoc.page.areas[0]).toMatchObject({ n: 1, id: "testpage#1" });
    expect(pageDoc.page.areas[0].anchors.testId).toBe("fixture-btn");
    expect(pageDoc.page.areas[0].pct).toBeTruthy();
  }, 30000);

  it("adds a page-level step through the UI, edits its description, toggles it off, and it persists across reload", async () => {
    const p = page!;
    await p.getByRole("button", { name: "Page step" }).click();
    await p.locator(".dr-step-desc").first().waitFor({ state: "visible", timeout: 5000 });

    await p.locator(".dr-step-desc").first().fill("Page loads under 3s with no console errors.");
    await p.locator(".dr-step-desc").first().blur();
    await p.waitForTimeout(300); // debounce-free save, but let the PUT round-trip land

    let doc = await (await fetch(`${DRILL_BASE}/api/pages/testpage`)).json();
    expect(doc.page.steps).toHaveLength(1);
    expect(doc.page.steps[0]).toMatchObject({ area: 0, enabled: true, description: "Page loads under 3s with no console errors." });

    // toggle off via the checkbox
    await p.locator(".dr-checkbox").first().click();
    await p.waitForTimeout(300);
    doc = await (await fetch(`${DRILL_BASE}/api/pages/testpage`)).json();
    expect(doc.page.steps[0].enabled).toBe(false);

    // reload the whole app and confirm the step + its disabled state survived
    await p.reload();
    await p.getByRole("button", { name: "Authoring" }).click();
    await p.locator(".dr-step-desc").first().waitFor({ state: "visible", timeout: 10000 });
    expect(await p.locator(".dr-step-desc").first().inputValue()).toBe("Page loads under 3s with no console errors.");

    // toggle back on, then remove it
    await p.locator(".dr-checkbox").first().click();
    await p.waitForTimeout(300);
    doc = await (await fetch(`${DRILL_BASE}/api/pages/testpage`)).json();
    expect(doc.page.steps[0].enabled).toBe(true);

    await p.locator(".dr-xbtn").first().click();
    await p.waitForTimeout(300);
    doc = await (await fetch(`${DRILL_BASE}/api/pages/testpage`)).json();
    expect(doc.page.steps).toHaveLength(0);
  }, 30000);
});
