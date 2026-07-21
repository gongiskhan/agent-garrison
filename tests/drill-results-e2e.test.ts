import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { waitExit } from "./helpers/wait-exit";

// Run & results, real UI: click Run, watch a result render with a tier
// badge, mark it failed, confirm the resulting finding, and dispatch it —
// end to end through the actual rendered React app, not just the API.

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const AUTOMATIONS_START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const BROWSER_PORT = 7205;
const AUTOMATIONS_PORT = 7206;
const DRILL_PORT = 7207;
const BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-results-home-"));
const adir = mkdtempSync(path.join(tmpdir(), "garrison-results-autos-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-results-target-"));

let browserSrv: ChildProcess | null = null;
let automationsSrv: ChildProcess | null = null;
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

const FIXTURE_URL = "data:text/html," + encodeURIComponent('<div data-testid="answer">The answer.</div>');

beforeAll(async () => {
  browserSrv = spawn("node", [BROWSER_START, "--port", String(BROWSER_PORT), "--host", "127.0.0.1"], {
    stdio: "ignore", env: { ...process.env, GARRISON_HOME: ghome }
  });
  expect(await waitHealthy(BROWSER_BASE, 15000)).toBe(true);

  automationsSrv = spawn("node", [AUTOMATIONS_START], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome, GARRISON_AUTOMATIONS_DIR: adir, GARRISON_BROWSER_URL: BROWSER_BASE, AUTOMATIONS_UI_PORT: String(AUTOMATIONS_PORT), AUTOMATIONS_UI_HOST: "127.0.0.1" }
  });
  expect(await waitHealthy(AUTOMATIONS_BASE, 8000)).toBe(true);

  drillSrv = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome, GARRISON_DRILL_TARGET_REPO: target, DRILL_UI_PORT: String(DRILL_PORT), DRILL_UI_HOST: "127.0.0.1" }
  });
  expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);

  await fetch(`${DRILL_BASE}/api/drillbook`, {
    // This test exercises run+override+confirm, not the A5/R7 gate (see
    // drill-gate-ui.test.ts) — run immediately.
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: { name: "f", url: FIXTURE_URL }, autonomy: "auto" })
  });
  await fetch(`${DRILL_BASE}/api/pages/answer`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Answer", path: "",
      steps: [{ id: "s1", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "answer visible", assertion: { kind: "visible", testId: "answer" }, tags: [] }]
    })
  });

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
}, 30000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  if (browserSrv && !browserSrv.killed) browserSrv.kill("SIGTERM");
  await waitExit(browserSrv);
  if (automationsSrv && !automationsSrv.killed) automationsSrv.kill("SIGKILL");
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  browserSrv = null; automationsSrv = null; drillSrv = null;
    rmSync(ghome, { recursive: true, force: true });
  rmSync(adir, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
}, 15000);

describe("Run & results — real UI", () => {
  it("runs a page from the UI, shows a tier badge, marks it failed, confirms the finding", async () => {
    const p = page!;
    await p.goto(DRILL_BASE);
    await p.getByRole("tab", { name: "Run & results" }).click();
    await p.getByText("Answer").click();
    // "desktop" is pre-selected by default (ResultsView's initial state) —
    // clicking it would DEselect it, so leave it alone.
    await p.getByRole("button", { name: "Run selected", exact: true }).click();

    // Debrief (Evidence V2) is the default run-detail surface; the classic
    // per-check rows this test pins live behind the view toggle now.
    const classicToggle = p.getByRole("button", { name: "Classic view" });
    await classicToggle.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    if (await classicToggle.count()) await classicToggle.click();
    // This wait covers an ACTUAL QA run (drive a browser, assert, render) — the
    // genuinely slow step, and the one that stretches when the full suite runs
    // 350+ files in parallel. At 15s it flaked under load while passing in
    // isolation in ~4s (same failure mode drill-gate-ui.test.ts hit); the
    // sequential waits below also summed past the old 40s test budget. Budget
    // the run generously and give the test headroom for the sum.
    await p.locator(".dr-res").first().waitFor({ state: "visible", timeout: 45000 });
    // Everything downstream of the run rides the same contention: keep these
    // waits generous too, or each one is its own flake point under load.
    await p.getByText(/cached|vision|recovered/).first().waitFor({ timeout: 30000 });

    await p.getByRole("button", { name: "Mark failed" }).click();
    await p.getByText(/Overridden -> failed/).waitFor({ timeout: 15000 });

    // the override auto-pooled a verdict-flip finding — confirm it and
    // dispatch, both still in the classic detail (the sticky-view fix keeps
    // classic showing across the refetches these mutations trigger)
    await p.getByRole("button", { name: "Confirm" }).first().click();
    await p.getByText("confirmed", { exact: true }).first().waitFor({ timeout: 15000 });

    const fixBtn = p.getByRole("button", { name: /Send confirmed to Code/ });
    await fixBtn.waitFor({ state: "visible", timeout: 15000 });
    expect(await fixBtn.isDisabled()).toBe(false);
  }, 180000);
});
