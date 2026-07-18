import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";

// Acceptance coverage for two results-page contracts which are easy to make
// look correct with fixture text while still being broken in real use:
// evidence is fetched as an image through confined HTTP routes (never shown
// as a host path), and review decisions are scoped to one viewport while old
// page:step records remain readable as fallbacks.

const REPO = path.resolve(__dirname, "..");
const AUTOMATIONS_START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const AUTOMATIONS_PORT = 7315;
const DRILL_PORT = 7316;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-drill-evidence-home-"));
const adir = mkdtempSync(path.join(tmpdir(), "garrison-drill-evidence-autos-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-drill-evidence-target-"));
const drillRunId = "01DRILLEVIDENCE000000000000";
const deterministicRunId = "01DRILLDETERMINISTIC00000000";
const rejectedReferenceRunId = "01DRILLREJECTEDREFERENCE000";
const startedAt = "2026-07-17T12:00:00.000Z";
const endedAt = "2026-07-17T12:00:05.000Z";

let automationsSrv: ChildProcess | null = null;
let drillSrv: ChildProcess | null = null;
let browser: Browser | null = null;
let page: Page | null = null;

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch {
      // Still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function seedAutomationRun({
  id,
  status,
  stepStatus,
  passed,
  evidencePath,
  reasoning,
  error,
  tier
}: {
  id: string;
  status: string;
  stepStatus: string;
  passed: boolean;
  evidencePath?: string;
  reasoning?: string;
  error?: string;
  tier?: string;
}) {
  const runsDir = path.join(adir, "runs");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, `${id}.json`), JSON.stringify({
    id,
    automationId: `drill-answer-s1-${id}`,
    status,
    startedAt,
    endedAt,
    steps: [{
      stepId: "s1",
      status: stepStatus,
      tier: tier ?? (passed ? "cached" : "vision"),
      evidencePath,
      durationMs: 25,
      error,
      result: { passed, reasoning }
    }]
  }, null, 2));
}

function resultCard(p: Page, viewport: string): Locator {
  return p.locator(".dr-res").filter({ has: p.locator(".chip", { hasText: viewport }) });
}

beforeAll(async () => {
  automationsSrv = spawn("node", [AUTOMATIONS_START], {
    stdio: "ignore",
    env: {
      ...process.env,
      GARRISON_HOME: ghome,
      GARRISON_AUTOMATIONS_DIR: adir,
      AUTOMATIONS_UI_PORT: String(AUTOMATIONS_PORT),
      AUTOMATIONS_UI_HOST: "127.0.0.1"
    }
  });
  expect(await waitHealthy(AUTOMATIONS_BASE, 8_000)).toBe(true);

  drillSrv = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: {
      ...process.env,
      GARRISON_HOME: ghome,
      GARRISON_DRILL_TARGET_REPO: target,
      DRILL_UI_PORT: String(DRILL_PORT),
      DRILL_UI_HOST: "127.0.0.1"
    }
  });
  expect(await waitHealthy(DRILL_BASE, 8_000)).toBe(true);

  await fetch(`${DRILL_BASE}/api/drillbook`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: { name: "Evidence fixture", url: "about:blank" }, autonomy: "auto" })
  });
  await fetch(`${DRILL_BASE}/api/pages/answer`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Answer",
      path: "",
      steps: [{
        id: "s1",
        area: 0,
        mode: "vision",
        enabled: true,
        state: "default",
        viewports: ["desktop", "mobile", "tablet", "wide"],
        description: "Answer panel is visually correct",
        tags: []
      }]
    })
  });

  // A real bitmap is required: the historical tests used four JPEG marker
  // bytes, which proves file writing but deliberately cannot prove <img>
  // rendering. Chromium sniffs this PNG correctly even though the evidence
  // API preserves its documented image/jpeg response type.
  const imageBytes = readFileSync(path.join(REPO, "public", "icons", "icon-192.png"));
  const passEvidence = path.join(adir, "runs", "auto-pass", "evidence", "step-000.jpg");
  const failEvidence = path.join(adir, "runs", "auto-fail", "evidence", "step-000.jpg");
  const missingEvidence = path.join(adir, "runs", "auto-missing", "evidence", "step-000.jpg");
  const outsideEvidence = path.join(adir, "outside-evidence.jpg");
  mkdirSync(path.dirname(passEvidence), { recursive: true });
  mkdirSync(path.dirname(failEvidence), { recursive: true });
  mkdirSync(path.join(adir, "runs", "auto-outside", "evidence"), { recursive: true });
  writeFileSync(passEvidence, imageBytes);
  writeFileSync(failEvidence, imageBytes);
  writeFileSync(outsideEvidence, imageBytes);

  seedAutomationRun({
    id: "auto-pass",
    status: "completed",
    stepStatus: "completed",
    passed: true,
    evidencePath: passEvidence,
    reasoning: "The answer panel is visible."
  });
  seedAutomationRun({
    id: "auto-fail",
    status: "failed",
    stepStatus: "failed",
    passed: false,
    evidencePath: failEvidence,
    reasoning: "The answer panel is clipped.",
    error: "Visual assertion failed"
  });
  seedAutomationRun({
    id: "auto-missing",
    status: "completed",
    stepStatus: "completed",
    passed: true,
    evidencePath: missingEvidence,
    reasoning: "The evidence file was removed after the run."
  });
  seedAutomationRun({
    id: "auto-outside",
    status: "completed",
    stepStatus: "completed",
    passed: true,
    evidencePath: outsideEvidence,
    reasoning: "This path must never be served."
  });
  seedAutomationRun({
    id: "auto-deterministic",
    status: "completed",
    stepStatus: "completed",
    passed: true,
    tier: "execute"
  });

  const runsDir = path.join(ghome, "drill", "runs");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, `${drillRunId}.json`), JSON.stringify({
    id: drillRunId,
    startedAt,
    endedAt,
    contextTag: "drill",
    state: "default",
    project: target,
    dispatch: "manual",
    dispatchedAt: null,
    pages: [
      { pageId: "answer", stepId: "s1", viewportId: "desktop", automationRunId: "auto-pass", status: "completed" },
      { pageId: "answer", stepId: "s1", viewportId: "mobile", automationRunId: "auto-fail", status: "failed" },
      { pageId: "answer", stepId: "s1", viewportId: "tablet", automationRunId: "auto-missing", status: "completed" },
      { pageId: "answer", stepId: "s1", viewportId: "wide", automationRunId: "auto-outside", status: "completed" }
    ],
    feedback: {
      "answer:s1": [{ id: "legacy-note", note: "Legacy note applies to every viewport.", at: startedAt }],
      "answer:s1:desktop": [{ id: "desktop-note", note: "Desktop-only note.", at: startedAt }]
    },
    overrides: {
      "answer:s1": { verdict: "failed", note: "Legacy review fallback", at: startedAt },
      "answer:s1:desktop": { verdict: "passed", note: "Desktop was rechecked", at: startedAt }
    },
    observations: [],
    findings: [{
      id: "mobile-finding",
      kind: "step-fail",
      pageId: "answer",
      stepId: "s1",
      viewportId: "mobile",
      text: "The answer panel is clipped.",
      status: "proposed",
      at: endedAt
    }],
    infraErrors: []
  }, null, 2));
  writeFileSync(path.join(runsDir, `${deterministicRunId}.json`), JSON.stringify({
    id: deterministicRunId,
    startedAt: "2026-07-17T11:59:00.000Z",
    endedAt: "2026-07-17T11:59:01.000Z",
    contextTag: "drill",
    state: "default",
    project: target,
    dispatch: "manual",
    dispatchedAt: null,
    pages: [
      { pageId: "answer", stepId: "s1", viewportId: "desktop", automationRunId: "auto-deterministic", status: "completed" }
    ],
    feedback: {},
    overrides: {},
    observations: [],
    findings: [],
    infraErrors: []
  }, null, 2));
  writeFileSync(path.join(runsDir, `${rejectedReferenceRunId}.json`), JSON.stringify({
    id: rejectedReferenceRunId,
    startedAt: "2026-07-17T11:58:00.000Z",
    endedAt: "2026-07-17T11:58:01.000Z",
    contextTag: "drill",
    state: "empty",
    project: target,
    dispatch: "manual",
    dispatchedAt: null,
    pages: [{
      pageId: "answer",
      stepId: "s1",
      viewportId: "desktop",
      automationRunId: "auto-pass",
      status: "completed",
      stateReferenceRejected: {
        state: "empty",
        reason: "unexpected-page-error",
        warnings: [{ code: "visible-timeout", text: "Request timed out after 120000ms" }]
      }
    }],
    feedback: {},
    overrides: {},
    observations: [],
    findings: [],
    infraErrors: []
  }, null, 2));

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
}, 30_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  if (automationsSrv && !automationsSrv.killed) automationsSrv.kill("SIGKILL");
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  automationsSrv = null;
  drillSrv = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(adir, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
}, 15_000);

describe("Drill evidence and viewport-scoped review", () => {
  it("explains a passed deterministic result that has no reasoning or screenshot", async () => {
    const p = page!;
    await p.goto(`${DRILL_BASE}/?view=results&run=${deterministicRunId}`);
    const card = resultCard(p, "desktop");
    await card.getByText("Deterministic check — no screenshot was captured.", { exact: true }).waitFor({ timeout: 10_000 });
    expect(await card.locator(".dr-evidence-image").count()).toBe(0);
  }, 30_000);

  it("explains why contaminated evidence was not saved as a state reference", async () => {
    const p = page!;
    await p.goto(`${DRILL_BASE}/?view=results&run=${rejectedReferenceRunId}`);
    const card = resultCard(p, "desktop");
    await card.getByText(
      "State reference not saved: the screenshot also contains an unexpected page error (“Request timed out after 120000ms”).",
      { exact: true }
    ).waitFor({ timeout: 10_000 });
  }, 30_000);

  it("renders pass and failure evidence through confined URLs, hides host paths, and explains a missing image", async () => {
    const p = page!;
    await p.goto(`${DRILL_BASE}/?view=results&run=${drillRunId}`);
    await p.locator(".dr-res").first().waitFor({ state: "visible", timeout: 10_000 });

    const passImage = resultCard(p, "desktop").locator(".dr-evidence-image");
    const failImage = resultCard(p, "mobile").locator(".dr-evidence-image");
    await expect.poll(() => passImage.evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0);
    await expect.poll(() => failImage.evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await passImage.getAttribute("src")).toBe(`/api/runs/${drillRunId}/evidence/answer/s1/desktop`);
    expect(await failImage.getAttribute("src")).toBe(`/api/runs/${drillRunId}/evidence/answer/s1/mobile`);

    await resultCard(p, "tablet").getByText("Evidence image unavailable", { exact: true }).waitFor({ timeout: 10_000 });
    const rendered = await p.locator("body").evaluate((body) => ({
      text: (body as HTMLElement).innerText,
      html: body.innerHTML
    }));
    expect(rendered.text).not.toContain(adir);
    expect(rendered.html).not.toContain(adir);
    expect(rendered.text).not.toContain("evidencePath");

    const passResponse = await fetch(`${DRILL_BASE}/api/runs/${drillRunId}/evidence/answer/s1/desktop`);
    expect(passResponse.status).toBe(200);
    expect(passResponse.headers.get("content-type")).toBe("image/jpeg");
    expect((await passResponse.arrayBuffer()).byteLength).toBeGreaterThan(100);

    const missingResponse = await fetch(`${DRILL_BASE}/api/runs/${drillRunId}/evidence/answer/s1/tablet`);
    expect(missingResponse.status).toBe(404);
  }, 30_000);

  it("refuses an evidence path outside its run directory at both API layers", async () => {
    const direct = await fetch(`${AUTOMATIONS_BASE}/api/runs/auto-outside/steps/s1/evidence`);
    expect(direct.status).toBe(403);
    expect(await direct.text()).not.toContain(readFileSync(path.join(adir, "outside-evidence.jpg")).toString("base64"));

    const proxied = await fetch(`${DRILL_BASE}/api/runs/${drillRunId}/evidence/answer/s1/wide`);
    expect(proxied.status).not.toBe(200);
    expect(await proxied.text()).toContain("evidence path escapes");
  });

  it("uses viewport-specific feedback and overrides while preserving legacy page:step fallbacks", async () => {
    const p = page!;
    const desktop = resultCard(p, "desktop");
    const mobile = resultCard(p, "mobile");
    const tablet = resultCard(p, "tablet");
    const wide = resultCard(p, "wide");

    // Both cards inherit the old unscoped note. Only desktop receives its
    // scoped note and scoped pass override; mobile/tablet use the old failed
    // override until a new viewport-specific review is written.
    await desktop.getByText("Legacy note applies to every viewport.", { exact: true }).waitFor();
    await mobile.getByText("Legacy note applies to every viewport.", { exact: true }).waitFor();
    await desktop.getByText("Desktop-only note.", { exact: true }).waitFor();
    expect(await mobile.getByText("Desktop-only note.", { exact: true }).count()).toBe(0);
    await desktop.getByRole("button", { name: "Mark failed", exact: true }).waitFor();
    await mobile.getByRole("button", { name: "Mark passed", exact: true }).waitFor();
    await tablet.getByRole("button", { name: "Mark passed", exact: true }).waitFor();
    await expect.poll(() => p.locator(".dr-run-summary").innerText()).toContain("1 passed");
    await expect.poll(() => p.locator(".dr-run-summary").innerText()).toContain("3 failed");

    const mobileInput = mobile.locator(".dr-feedback");
    await mobileInput.fill("Mobile-only reviewer note.");
    await mobileInput.press("Enter");
    await mobile.getByText("Mobile-only reviewer note.", { exact: true }).waitFor({ timeout: 10_000 });
    expect(await desktop.getByText("Mobile-only reviewer note.", { exact: true }).count()).toBe(0);

    await mobile.getByRole("button", { name: "Mark passed", exact: true }).click();
    await mobile.getByText(/Overridden -> passed/).waitFor({ timeout: 10_000 });
    const stored = await (await fetch(`${DRILL_BASE}/api/runs/${drillRunId}`)).json();
    expect(stored.run.feedback["answer:s1:mobile"][0].note).toBe("Mobile-only reviewer note.");
    expect(stored.run.overrides["answer:s1:mobile"]).toMatchObject({ verdict: "passed" });
    expect(stored.run.overrides["answer:s1"]).toMatchObject({ verdict: "failed" });
    expect(stored.run.overrides["answer:s1:desktop"]).toMatchObject({ verdict: "passed" });
    await expect.poll(() => p.locator(".dr-run-summary").innerText()).toContain("2 passed");
    await expect.poll(() => p.locator(".dr-run-summary").innerText()).toContain("2 failed");

    // Once each remaining viewport is explicitly reviewed as passing, both
    // the selected totals and the dated history verdict must update. The old
    // unscoped fallback remains in the record but no longer wins over any
    // viewport-specific decision.
    await tablet.getByRole("button", { name: "Mark passed", exact: true }).click();
    await wide.getByRole("button", { name: "Mark passed", exact: true }).click();
    await expect.poll(() => p.locator(".dr-run-summary").innerText()).toContain("4 passed");
    await expect.poll(() => p.locator(".dr-run-summary").innerText()).toContain("0 failed");
    await expect.poll(() => p.locator(".dr-run-summary").innerText()).toContain("0 findings");
    const historyRow = p.locator(".dr-history-table tbody tr").filter({ hasText: drillRunId });
    await expect.poll(() => historyRow.locator('[data-label="Outcome"] .chip').first().innerText()).toBe("Passed");

    const invalidViewport = await fetch(`${DRILL_BASE}/api/runs/${drillRunId}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageId: "answer", stepId: "s1", viewportId: "watch", note: "must not persist" })
    });
    expect(invalidViewport.status).toBe(400);
  }, 30_000);

  it("offers explicit page attribution when converting an observation to a finding", async () => {
    const p = page!;
    const added = await fetch(`${DRILL_BASE}/api/runs/${drillRunId}/observation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "The empty state copy is confusing." })
    });
    expect(added.status).toBe(200);
    const { observation } = await added.json();

    await p.goto(`${DRILL_BASE}/?view=results&run=${drillRunId}`);
    const attribution = p.getByLabel(/Attribute observation .* to a product page/);
    await attribution.waitFor();
    expect(await attribution.inputValue()).toBe("");
    const before = await (await fetch(`${DRILL_BASE}/api/runs/${drillRunId}`)).json();
    expect(before.run.observations.find((item: any) => item.id === observation.id).convertedToFinding).toBeNull();

    await attribution.selectOption("answer");
    await p.getByText(/\[observation\] answer: The empty state copy is confusing\./).waitFor({ timeout: 10_000 });
    const after = await (await fetch(`${DRILL_BASE}/api/runs/${drillRunId}`)).json();
    expect(after.run.observations.find((item: any) => item.id === observation.id).convertedToFinding).toBeTruthy();
  }, 30_000);
});
