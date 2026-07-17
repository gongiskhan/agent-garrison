import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "../fittings/seed/drill/test-fixtures/serve.mjs";

// D5 — the fixture app itself: deterministic, reproducible, ships the one
// intentional bug (citation index mismatch) and the one mobile-only bug
// (cancel button hidden below 500px).

const PORT = 7251;
const BASE = `http://127.0.0.1:${PORT}`;
let server: import("node:http").Server;
let browser: Browser;

beforeAll(async () => {
  server = await startFixtureServer(PORT);
  browser = await chromium.launch({ headless: true });
}, 15000);

afterAll(async () => {
  await browser.close();
  await new Promise((r) => server.close(() => r(undefined)));
});

describe("chat.html", () => {
  it("citation [2] points at source 2 by default", async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/chat.html`);
    expect(await page.getByTestId("citation-2").getAttribute("data-source-index")).toBe("2");
    await page.close();
  });

  it("?bug=1 flips citation [2] to point at source 1 (the intentional mismatch) — both the deterministic attribute and the visible source text", async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/chat.html?bug=1`);
    expect(await page.getByTestId("citation-2").getAttribute("data-source-index")).toBe("1");
    expect(await page.getByTestId("source-2").textContent()).toBe("2. CT art. 269"); // duplicates source 1's text — visually wrong
    await page.close();
  });
});

describe("build.html", () => {
  it("idle -> building -> complete via the real timer", async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/build.html`);
    await expectVisible(page, "idle-panel");
    await page.getByTestId("start-build-btn").click();
    await expectVisible(page, "building-panel");
    await page.getByTestId("complete-panel").waitFor({ state: "visible", timeout: 5000 });
    // The building panel (progress-pct included) unmounts once complete —
    // a real SPA conditionally renders its screens rather than leaving a
    // finished progress bar frozen in the DOM — so "reached complete" is
    // verified via the complete panel's own content, not a now-gone label.
    expect(await page.getByTestId("build-complete").textContent()).toBe("Build complete");
    await page.close();
  });

  it("the __drillSetProgress test hook jumps deterministically (for snapshot capture)", async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/build.html`);
    await page.evaluate(() => (window as any).__drillSetProgress(8));
    expect(await page.getByTestId("progress-pct").textContent()).toBe("8%");
    await expectVisible(page, "building-panel");
    await page.evaluate(() => (window as any).__drillSetProgress(64));
    expect(await page.getByTestId("progress-pct").textContent()).toBe("64%");
    await page.close();
  });

  it("the cancel button is visible on desktop but hidden below 500px (the intentional mobile-only bug)", async () => {
    const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await desktop.goto(`${BASE}/build.html`);
    await desktop.evaluate(() => (window as any).__drillSetProgress(50));
    expect(await desktop.getByTestId("cancel-btn").isVisible()).toBe(true);
    await desktop.close();

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(`${BASE}/build.html`);
    await mobile.evaluate(() => (window as any).__drillSetProgress(50));
    expect(await mobile.getByTestId("cancel-btn").isVisible()).toBe(false);
    await mobile.close();
  });
});

async function expectVisible(page: import("playwright").Page, testId: string) {
  await page.getByTestId(testId).waitFor({ state: "visible", timeout: 5000 });
}
