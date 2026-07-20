import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { waitExit } from "./helpers/wait-exit";

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

async function evalInBrowserTab(tabId: string, js: string) {
  const response = await fetch(`${BROWSER_BASE}/tabs/${encodeURIComponent(tabId)}/eval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ js })
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  return body.value;
}

// Fixture: a single clearly-testid'd button at a known position within the
// desktop viewport (1280x800) so the overlay-click math is checkable.
const FIXTURE_URL =
  "data:text/html," +
  encodeURIComponent(
    '<body style="margin:0"><div style="width:100%;height:100%;position:relative;background:#fff">' +
      '<button data-testid="fixture-btn" style="position:absolute;top:100px;left:100px;width:160px;height:44px">Click me</button>' +
      "</div></body>"
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
  await waitExit(browserSrv);
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
    await p.getByRole("tab", { name: "Authoring" }).click();
    await p.locator(".dr-cv").waitFor({ state: "visible", timeout: 15000 });

    // The rendered preview is now the exact 1280x800 page screenshot, with
    // no Browser toolbar or iframe-resize coordinate drift.
    const preview = p.locator(".dr-cv-frame");
    await preview.waitFor({ state: "visible", timeout: 10000 });
    await p.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>(".dr-cv-frame");
      return !!image?.complete && image.naturalWidth > 0;
    });
    expect(await preview.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([1280, 800]);

    await p.getByRole("button", { name: "Highlight an area", exact: true }).first().click();
    await p.getByText(/Click the element you want Drill to track/i).waitFor({ timeout: 5000 });

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
    const badgeBox = await p.locator(".dr-abox").boundingBox();
    const settledPreviewBox = await p.locator(".dr-cv-overlay").boundingBox();
    expect(badgeBox).toBeTruthy();
    expect(settledPreviewBox).toBeTruthy();
    expect(Math.abs(badgeBox!.x - (settledPreviewBox!.x + (100 / 1280) * settledPreviewBox!.width))).toBeLessThan(3);
    expect(Math.abs(badgeBox!.y - (settledPreviewBox!.y + (100 / 800) * settledPreviewBox!.height))).toBeLessThan(3);

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
    await p.getByRole("tab", { name: "Authoring" }).click();
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

  it("serializes rapid authoring writes and continues the queue after one save fails", async () => {
    const p = page!;
    let activePuts = 0;
    let maxActivePuts = 0;
    let putCount = 0;
    let failPut = -1;

    await p.route(`${DRILL_BASE}/api/pages/testpage`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      putCount += 1;
      const thisPut = putCount;
      activePuts += 1;
      maxActivePuts = Math.max(maxActivePuts, activePuts);
      try {
        // Long enough that an implementation which fires writes in parallel
        // reliably overlaps here.
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (thisPut === failPut) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "injected authoring save failure" })
          });
          return;
        }
        const response = await route.fetch();
        await route.fulfill({ response });
      } finally {
        activePuts -= 1;
      }
    });

    const addPageStep = p.getByRole("button", { name: "Page step", exact: true });
    // Synchronous DOM clicks expose stale-state/racing implementations that
    // three awaited Playwright clicks would accidentally hide.
    await addPageStep.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
      button.click();
    });
    await expect.poll(() => putCount, { timeout: 10_000 }).toBe(3);
    await expect.poll(async () => {
      const doc = await (await fetch(`${DRILL_BASE}/api/pages/testpage`)).json();
      return doc.page.steps.length;
    }, { timeout: 10_000 }).toBe(3);
    expect(maxActivePuts).toBe(1);
    await p.getByTestId("author-save-status").getByText("Saved", { exact: true }).waitFor();

    // The first operation in this second burst fails. Its queued successor
    // must still run against the latest persisted page instead of leaving
    // authoring permanently wedged behind a rejected promise.
    failPut = putCount + 1;
    await addPageStep.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect.poll(() => putCount, { timeout: 10_000 }).toBe(5);
    await expect.poll(async () => {
      const doc = await (await fetch(`${DRILL_BASE}/api/pages/testpage`)).json();
      return doc.page.steps.length;
    }, { timeout: 10_000 }).toBe(4);
    expect(maxActivePuts).toBe(1);
    await p.getByTestId("author-save-status").getByText("Saved", { exact: true }).waitFor();
    expect(await p.getByRole("alert").count()).toBe(0);

    await p.unroute(`${DRILL_BASE}/api/pages/testpage`);
  }, 30000);

  it("starts one frozen targeting session on a double click and always thaws it on cancel or unmount", async () => {
    const p = page!;
    const opened = await (
      await fetch(`${DRILL_BASE}/api/authoring/tab`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageId: "testpage", viewport: "desktop" })
      })
    ).json();
    const freezeRequests: Array<{ frozen?: boolean }> = [];
    const recordFreeze = (request: import("playwright").Request) => {
      if (request.url() === `${DRILL_BASE}/api/authoring/freeze` && request.method() === "POST") {
        freezeRequests.push(request.postDataJSON());
      }
    };
    p.on("request", recordFreeze);

    const highlight = p.getByRole("button", { name: "Highlight an area", exact: true }).first();
    await highlight.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await p.locator(".dr-pick-cancel").waitFor({ state: "visible", timeout: 10_000 });
    expect(freezeRequests.filter((body) => body.frozen !== false)).toHaveLength(1);
    expect(await evalInBrowserTab(opened.tabId, "document.getElementById('__garrison_drill_freeze__') ? 1 : 0")).toBe(1);

    await p.locator(".dr-pick-cancel").click();
    await expect.poll(
      () => evalInBrowserTab(opened.tabId, "document.getElementById('__garrison_drill_freeze__') ? 1 : 0"),
      { timeout: 10_000 }
    ).toBe(0);

    // A navigation unmount is a different cleanup path from explicit Cancel.
    await highlight.click();
    await p.locator(".dr-pick-cancel").waitFor({ state: "visible", timeout: 10_000 });
    expect(await evalInBrowserTab(opened.tabId, "document.getElementById('__garrison_drill_freeze__') ? 1 : 0")).toBe(1);
    await p.getByRole("tab", { name: "Drill Book", exact: true }).click({ force: true });
    await expect.poll(
      () => evalInBrowserTab(opened.tabId, "document.getElementById('__garrison_drill_freeze__') ? 1 : 0"),
      { timeout: 10_000 }
    ).toBe(0);

    p.off("request", recordFreeze);
  }, 30000);

  it("Go to page re-navigates a wandered live tab back to the authored page's path", async () => {
    const p = page!;
    await p.goto(DRILL_BASE);
    await p.getByRole("tab", { name: "Authoring" }).click();
    const urlInput = p.locator(".dr-urlin");
    await urlInput.waitFor({ state: "visible", timeout: 15000 });

    const opened = await (await fetch(`${DRILL_BASE}/api/authoring/tab`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageId: "testpage", viewport: "desktop" })
    })).json();

    const tabUrl = async () => {
      const info = await (await fetch(`${DRILL_BASE}/api/authoring/tab-info?tabId=${encodeURIComponent(opened.tabId)}`)).json();
      return info.tab?.url ?? "";
    };

    // Wander off the page - the auth-gated app's /login redirect in miniature.
    await urlInput.fill("about:blank");
    await urlInput.press("Enter");
    await expect.poll(tabUrl, { timeout: 10000 }).toBe("about:blank");

    // Stranded off the page path -> the button lights up as the primary action
    // and one click brings the live tab back to the authored page.
    const goToPage = p.getByRole("button", { name: "Go to page", exact: true });
    await expect.poll(async () => (await goToPage.getAttribute("class")) ?? "", { timeout: 10000 }).toContain("primary");
    await goToPage.click();
    await expect.poll(tabUrl, { timeout: 10000 }).toBe(FIXTURE_URL);
  }, 30000);

  it("renders reach guidance and survives a malformed reachPath without blanking the app", async () => {
    const p = page!;
    // A page whose states carry a well-formed reach path AND a malformed one
    // (reachPath as a bare string, and an entry with no description) - exactly
    // the shapes hand/planner-authored YAML can produce.
    await fetch(`${DRILL_BASE}/api/pages/statey`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Statey", path: "",
        states: [
          { id: "good", label: "good", reachPath: [{ id: "r1", description: "click the Guardrails tab" }, { id: "r2", description: "open the add dialog" }] },
          { id: "bad", label: "bad", reachPath: "click something" },
          { id: "empty", label: "empty", reachPath: [{ id: "r3" }] }
        ]
      })
    });

    await p.goto(DRILL_BASE);
    await p.getByRole("tab", { name: "Authoring" }).click();
    await p.locator(".dr-au-canvas").waitFor({ state: "visible", timeout: 15000 });
    await p.locator('select[aria-label="Authoring page"]').selectOption("statey");

    // Good state: guidance renders the joined descriptions.
    await p.getByRole("button", { name: "good", exact: true }).click();
    await p.locator(".dr-state-reach").waitFor({ state: "visible", timeout: 10000 });
    expect(await p.locator(".dr-state-reach").innerText())
      .toContain("click the Guardrails tab, then open the add dialog");

    // Malformed string reachPath: no crash (the app root is still mounted) and
    // no reach strip rendered.
    await p.getByRole("button", { name: "bad", exact: true }).click();
    await p.waitForTimeout(200);
    expect(await p.locator(".dr-au-canvas").count()).toBe(1);
    expect(await p.locator(".dr-state-reach").count()).toBe(0);

    // Descriptionless entry: no dangling "Reach it" label.
    await p.getByRole("button", { name: "empty", exact: true }).click();
    await p.waitForTimeout(200);
    expect(await p.locator(".dr-au-canvas").count()).toBe(1);
    expect(await p.locator(".dr-state-reach").count()).toBe(0);
  }, 30000);
});
