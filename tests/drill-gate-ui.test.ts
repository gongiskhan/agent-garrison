import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

// A5/R7/S22/self-test-item-10, real UI: clicking Run under a gated Drill
// Book shows the plan diff and does NOT run; "Approve and run" then runs it.

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const AUTOMATIONS_START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const BROWSER_PORT = 7243;
const AUTOMATIONS_PORT = 7244;
const DRILL_PORT = 7245;
const BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-gateui-home-"));
const adir = mkdtempSync(path.join(tmpdir(), "garrison-gateui-autos-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-gateui-target-"));

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

  // autonomy defaults to "gated" — deliberately left unset here.
  await fetch(`${DRILL_BASE}/api/drillbook`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: { name: "f", url: FIXTURE_URL } }) });
  await fetch(`${DRILL_BASE}/api/pages/answer`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Answer", path: "", steps: [{ id: "s1", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "answer is visible", assertion: { kind: "visible", testId: "answer" }, tags: [] }] })
  });

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
}, 30000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  if (browserSrv && !browserSrv.killed) browserSrv.kill("SIGTERM");
  if (automationsSrv && !automationsSrv.killed) automationsSrv.kill("SIGKILL");
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  browserSrv = null; automationsSrv = null; drillSrv = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(adir, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
}, 15000);

describe("gated autonomy — real UI", () => {
  it("shows the plan diff and does not run; Approve and run then runs it", async () => {
    const p = page!;
    await p.goto(DRILL_BASE);
    await p.getByRole("tab", { name: "Run & results" }).click();
    await p.getByText("Answer").click();
    await p.getByRole("button", { name: "Run selected", exact: true }).click();

    await p.getByText("Plan ready - gated, awaiting approval").waitFor({ timeout: 10000 });
    await p.getByText("answer is visible").waitFor({ timeout: 5000 });
    expect(await p.locator(".dr-res").count()).toBe(0); // nothing ran yet

    await p.getByRole("button", { name: "Approve and run" }).click();
    await p.locator(".dr-res").first().waitFor({ state: "visible", timeout: 15000 });
    await p.getByText("Plan ready").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  }, 40000);
});
