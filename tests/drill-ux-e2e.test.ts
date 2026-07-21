import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { waitExit } from "./helpers/wait-exit";

// Acceptance coverage for the manual-review failures that unit tests missed:
// real visual targeting, steps-left/browser-right geometry, dated paginated
// history, infra-noise separation, deep links, and container safety across
// desktop/tablet/phone widths.

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const BROWSER_PORT = 7293;
const DRILL_PORT = 7294;
const BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;
const HOME_TITLE = "Home page with an intentionally extraordinarily long title that must wrap inside its container";
const STATE_LABEL = "Ready state with an intentionally extraordinarily long label that must wrap inside its card";

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-drill-ux-home-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-drill-ux-target-"));

let browserSrv: ChildProcess | null = null;
let drillSrv: ChildProcess | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
const consoleErrors: string[] = [];

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function runRecord(index: number) {
  const startedAt = new Date(Date.UTC(2026, 6, 17, 9, index, 0)).toISOString();
  const endedAt = new Date(Date.UTC(2026, 6, 17, 9, index, 12)).toISOString();
  return {
    id: `01DRILLUX${String(index).padStart(16, "0")}`,
    startedAt,
    endedAt,
    contextTag: index === 7 ? "drill-adversarial" : "drill",
    state: "default",
    project: target,
    dispatch: "manual",
    dispatchedAt: null,
    pages: [{ pageId: "home", stepId: "hero", viewportId: "desktop", automationRunId: null, status: "completed" }],
    feedback: {},
    overrides: {},
    observations: [],
    findings: index === 7
      ? [
          { id: "real-finding", kind: "ux", pageId: "home", stepId: "hero", text: "Hero heading is clipped.", status: "proposed", at: endedAt },
          ...Array.from({ length: 20 }, (_, n) => ({
            id: `infra-${n}`,
            kind: "step-fail",
            pageId: "home",
            stepId: `infra-${n}`,
            text: n % 2 ? "vision 503" : "fixer 403",
            status: "proposed",
            at: endedAt
          }))
        ]
      : [],
    infraErrors: []
  };
}

beforeAll(async () => {
  browserSrv = spawn("node", [BROWSER_START, "--port", String(BROWSER_PORT), "--host", "127.0.0.1"], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome }
  });
  expect(await waitHealthy(BROWSER_BASE, 15_000)).toBe(true);

  drillSrv = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: {
      ...process.env,
      GARRISON_HOME: ghome,
      GARRISON_DRILL_TARGET_REPO: target,
      GARRISON_BROWSER_URL: BROWSER_BASE,
      DRILL_UI_PORT: String(DRILL_PORT),
      DRILL_UI_HOST: "127.0.0.1"
    }
  });
  expect(await waitHealthy(DRILL_BASE, 8_000)).toBe(true);

  const fixture = "data:text/html," + encodeURIComponent(
    '<body style="margin:0"><main style="position:relative;width:100%;height:100%;background:white">' +
    '<button data-testid="visible-target" style="position:absolute;left:100px;top:80px;width:200px;height:60px;background:#2f4a3a;color:white">Visible target</button>' +
    "</main></body>"
  );
  await fetch(`${DRILL_BASE}/api/drillbook`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: { name: "UX fixture", url: fixture }, autonomy: "auto", viewports: ["desktop", "mobile"] })
  });
  for (let index = 0; index < 8; index++) {
    const id = index === 0 ? "home" : `page-${index}`;
    await fetch(`${DRILL_BASE}/api/pages/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: index === 0 ? HOME_TITLE : `Page ${index}`,
        path: "",
        steps: index === 0
          ? [
              { id: "hero", area: 0, mode: "vision", enabled: true, state: "default", viewports: ["desktop"], description: "Hero is visible", tags: [] },
              { id: "ready-check", area: 0, mode: "vision", enabled: true, state: "ready", viewports: ["desktop"], description: "Ready state is visible", tags: [] }
            ]
          : [{ id: "hero", area: 0, mode: "vision", enabled: true, state: "default", viewports: ["desktop"], description: "Hero is visible", tags: [] }],
        states: index === 0
          ? [
              {
                id: "ready",
                label: STATE_LABEL,
                reachPath: [],
                matcher: { assertion: { kind: "text-contains", text: "Ready" } },
                screenshotPath: path.join(target, "missing-ready-reference.jpg"),
                referenceSource: { runId: runRecord(7).id, stepId: "ready-check", viewportId: "desktop", at: "2026-07-17T09:07:12.000Z" }
              },
              { id: "empty", label: "Empty", reachPath: [], matcher: {} }
            ]
          : []
      })
    });
  }

  const runsDir = path.join(ghome, "drill", "runs");
  mkdirSync(runsDir, { recursive: true });
  for (let index = 0; index < 8; index++) {
    const record = runRecord(index);
    writeFileSync(path.join(runsDir, `${record.id}.json`), JSON.stringify(record, null, 2));
  }

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
}, 30_000);

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
}, 15_000);

describe("Drill manual UX acceptance", () => {
  it("recovers from an authoring tab-load failure without reloading the page", async () => {
    const p = page!;
    let attempts = 0;
    await p.route("**/api/authoring/tab", async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporary Browser outage" })
        });
        return;
      }
      await route.continue();
    });
    try {
      await p.goto(`${DRILL_BASE}/?view=authoring&page=home`);
      await p.getByRole("alert").filter({ hasText: "temporary Browser outage" }).waitFor({ timeout: 10_000 });
      await p.getByRole("button", { name: "Retry opening tab" }).click();
      await p.locator(".dr-cv").waitFor({ state: "visible", timeout: 15_000 });
      expect(attempts).toBe(2);
    } finally {
      await p.unroute("**/api/authoring/tab");
      // The synthetic 502 above is the behavior under test, not a console
      // regression from any of the real surfaces measured later.
      consoleErrors.length = 0;
    }
  }, 30_000);

  it("navigates from a Book page to a durable Authoring deep link with steps left and browser right", async () => {
    const p = page!;
    await p.goto(DRILL_BASE);
    await p.locator(".dr-page-link").filter({ hasText: "Home" }).click();
    await p.locator(".dr-cv").waitFor({ state: "visible", timeout: 15_000 });
    expect(new URL(p.url()).searchParams.get("view")).toBe("authoring");
    expect(new URL(p.url()).searchParams.get("page")).toBe("home");

    const plan = await p.locator(".dr-au-plan").boundingBox();
    const canvas = await p.locator(".dr-au-canvas").boundingBox();
    expect(plan).toBeTruthy();
    expect(canvas).toBeTruthy();
    expect(plan!.x).toBeLessThan(canvas!.x);

    await p.reload();
    await p.locator(".dr-cv").waitFor({ state: "visible", timeout: 15_000 });
    expect(await p.locator(".dr-au-canvas select").inputValue()).toBe("home");
  }, 30_000);

  it("supports roving keyboard navigation across the section tabs without breaking browser history", async () => {
    const p = page!;
    await p.goto(DRILL_BASE);
    const selectedTab = () => p.getByRole("tab", { selected: true });
    const expectSelected = async (label: string, view: string) => {
      await expect.poll(() => selectedTab().textContent()).toBe(label);
      expect(new URL(p.url()).searchParams.get("view") ?? "book").toBe(view);
      expect(await p.getByRole("tab").evaluateAll((tabs) =>
        tabs.map((tab) => ({ label: tab.textContent, tabIndex: (tab as HTMLElement).tabIndex }))
      )).toEqual([
        { label: "Drill Book", tabIndex: view === "book" ? 0 : -1 },
        { label: "Authoring", tabIndex: view === "authoring" ? 0 : -1 },
        { label: "States", tabIndex: view === "states" ? 0 : -1 },
        { label: "Run & results", tabIndex: view === "results" ? 0 : -1 }
      ]);
    };
    const expectFocused = async (label: string) => {
      await expect.poll(() => p.evaluate(() => document.activeElement?.textContent)).toBe(label);
    };

    const book = p.getByRole("tab", { name: "Drill Book" });
    await book.focus();
    await p.keyboard.press("ArrowRight");
    await expectSelected("Authoring", "authoring");
    await expectFocused("Authoring");

    await p.keyboard.press("ArrowRight");
    await expectSelected("States", "states");
    await expectFocused("States");

    await p.goBack();
    await expectSelected("Authoring", "authoring");

    await p.getByRole("tab", { name: "Authoring" }).focus();
    await p.keyboard.press("Home");
    await expectSelected("Drill Book", "book");
    await expectFocused("Drill Book");

    await p.keyboard.press("ArrowLeft");
    await expectSelected("Run & results", "results");
    await expectFocused("Run & results");

    await p.keyboard.press("Home");
    await expectSelected("Drill Book", "book");
    await p.keyboard.press("End");
    await expectSelected("Run & results", "results");
    await expectFocused("Run & results");
  }, 30_000);

  it("targets the element where it is visibly rendered and persists the matching area", async () => {
    const p = page!;
    await p.goto(`${DRILL_BASE}/?view=authoring&page=home`);
    const image = p.locator(".dr-cv-frame");
    await image.waitFor({ state: "visible", timeout: 10_000 });
    await p.waitForFunction(() => {
      const preview = document.querySelector<HTMLImageElement>(".dr-cv-frame");
      return !!preview?.complete && preview.naturalWidth > 0;
    });
    expect(await image.evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight])).toEqual([1280, 800]);

    await p.getByRole("button", { name: "Highlight an area" }).click();
    await p.getByText(/Click the element you want Drill to track/i).waitFor({ timeout: 10_000 });
    const overlay = p.locator(".dr-cv-overlay");
    const box = await overlay.boundingBox();
    expect(box).toBeTruthy();
    await p.mouse.click(
      box!.x + (200 / 1280) * box!.width,
      box!.y + (110 / 800) * box!.height
    );
    const areaName = p.getByRole("textbox", { name: "Area 1 name" });
    await areaName.waitFor({ timeout: 10_000 });
    expect(await areaName.inputValue()).toBe("visible-target");

    const persisted = await (await fetch(`${DRILL_BASE}/api/pages/home`)).json();
    expect(persisted.page.areas[0].anchors.testId).toBe("visible-target");
    const areaBox = await p.locator(".dr-abox").boundingBox();
    await p.locator(".dr-cv-live").waitFor({ state: "visible", timeout: 10_000 });
    const liveFrame = p.frames().find((frame) => frame.url().includes(`/canvas/`));
    expect(liveFrame).toBeTruthy();
    const liveCanvas = await liveFrame!.locator(".canvas-wrapper").boundingBox();
    expect(areaBox).toBeTruthy();
    expect(liveCanvas).toBeTruthy();
    expect(await liveFrame!.locator(".urlbar").isVisible()).toBe(false);
    expect(Math.abs(areaBox!.x - (liveCanvas!.x + (100 / 1280) * liveCanvas!.width))).toBeLessThan(3);
    expect(Math.abs(areaBox!.y - (liveCanvas!.y + (80 / 800) * liveCanvas!.height))).toBeLessThan(3);
  }, 30_000);

  it("resets a named state when navigating to a page that does not define it", async () => {
    const p = page!;
    await p.goto(`${DRILL_BASE}/?view=authoring&page=home`);
    await p.locator(".dr-cv").waitFor({ state: "visible", timeout: 15_000 });
    await p.getByRole("button", { name: "ready", exact: true }).click();
    await p.locator(".dr-author-controls select").selectOption("page-1");
    await p.getByRole("button", { name: "Page step", exact: true }).click();

    await expect.poll(async () => {
      const stored = await (await fetch(`${DRILL_BASE}/api/pages/page-1`)).json();
      return stored.page.steps.at(-1)?.state;
    }, { timeout: 10_000 }).toBe("default");
    expect(new URL(p.url()).searchParams.get("page")).toBe("page-1");
  }, 30_000);

  it("replaces stale or missing state images honestly and prepares the exact reference run", async () => {
    const p = page!;
    await p.goto(`${DRILL_BASE}/?view=states`);
    await p.getByText("Recognized by: text “Ready” is present", { exact: true }).waitFor();
    await p.getByText("The recorded reference image is no longer available.", { exact: false }).waitFor({ timeout: 10_000 });
    await p.getByText("No reference image yet.", { exact: false }).waitFor();
    await p.getByRole("button", { name: "Add state checks in Authoring" }).waitFor();

    // Make the Results page-data fetch visibly slower than its shell render.
    // Prepared coverage must be correct on the first page-button commit, not
    // flash an empty/default selection until a passive effect catches up.
    let delayedPagesRequest = false;
    const delayResultsPages = async (route: Route) => {
      delayedPagesRequest = true;
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    };
    await p.route(`${DRILL_BASE}/api/pages`, delayResultsPages);
    try {
      await p.getByRole("button", { name: "Prepare reference run" }).click();
      await p.getByText("Start a run", { exact: true }).waitFor();
      expect(await p.getByRole("button", { name: HOME_TITLE }).getAttribute("aria-pressed")).toBe("true");
      expect(await p.locator("#dr-run-state").inputValue()).toBe("ready");
      expect(await p.getByRole("button", { name: "desktop", exact: true }).getAttribute("aria-pressed")).toBe("true");
      expect(delayedPagesRequest).toBe(true);
    } finally {
      await p.unroute(`${DRILL_BASE}/api/pages`, delayResultsPages);
    }
  }, 30_000);

  it("keeps several area overlays live with one light batch poll", async () => {
    const p = page!;
    const areas = Array.from({ length: 6 }, (_, index) => ({
      n: index + 1,
      id: `home#${index + 1}`,
      label: `Target ${index + 1}`,
      anchors: { testId: "visible-target", role: null, ariaLabel: null, text: "Visible target", tag: "button", css: null, cssMethod: null, xpath: null },
      pct: { leftPct: 100 / 1280 * 100, topPct: 80 / 800 * 100, widthPct: 200 / 1280 * 100, heightPct: 60 / 800 * 100 }
    }));
    const saved = await fetch(`${DRILL_BASE}/api/pages/home`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ areas })
    });
    expect(saved.status).toBe(200);

    let batchRequests = 0;
    let singleRequests = 0;
    const countRequests = (request: any) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/authoring/resolve-many") batchRequests += 1;
      if (pathname === "/api/authoring/resolve") singleRequests += 1;
    };
    p.on("request", countRequests);
    try {
      await p.goto(`${DRILL_BASE}/?view=authoring&page=home`);
      await p.locator(".dr-abox").first().waitFor({ state: "visible", timeout: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 6_200));
    } finally {
      p.off("request", countRequests);
    }
    expect(singleRequests).toBe(0);
    expect(batchRequests).toBeGreaterThanOrEqual(1);
    expect(batchRequests).toBeLessThanOrEqual(4);
    expect(await p.locator(".dr-abox").count()).toBe(6);
  }, 30_000);

  it("shows dated paginated history and keeps legacy infrastructure noise out of product findings", async () => {
    const p = page!;
    const newestId = runRecord(7).id;
    await p.goto(`${DRILL_BASE}/?view=results&run=${newestId}`);
    await p.getByText("Run history", { exact: true }).waitFor();
    await expect.poll(() => p.locator(".dr-history-table tbody tr").count()).toBe(6);
    await p.getByText(/Jul 17, 2026|17 Jul 2026/).first().waitFor();
    await p.getByText("Page 1 of 2").waitFor();
    await p.getByRole("button", { name: "Next" }).click();
    await expect.poll(() => p.locator(".dr-history-table tbody tr").count()).toBe(2);

    await p.goto(`${DRILL_BASE}/?view=results&run=${newestId}`);
    await p.getByText("Hero heading is clipped.").waitFor();
    expect(await p.getByRole("button", { name: "Confirm", exact: true }).count()).toBe(1);
    const infra = p.locator(".dr-infra");
    await infra.waitFor();
    expect(await infra.getAttribute("open")).toBeNull();
    await infra.locator("summary").click();
    await infra.getByText(/vision 503|fixer 403/).first().waitFor();
  }, 30_000);

  it("keeps dialog and mobile-sheet focus inside the active surface", async () => {
    const p = page!;
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.goto(`${DRILL_BASE}/?view=book`);

    const planTrigger = p.getByRole("button", { name: "Plan book" });
    await planTrigger.focus();
    await planTrigger.click();
    const dialog = p.getByRole("dialog", { name: "Plan the Drill Book" });
    await dialog.waitFor();
    const brief = dialog.getByRole("textbox", { name: "Change brief (optional)" });
    expect(await brief.evaluate((element) => element === document.activeElement)).toBe(true);

    // Shift+Tab from the first control wraps to the last control, and Tab
    // returns to the first instead of escaping behind the modal.
    await p.keyboard.press("Shift+Tab");
    const submit = dialog.getByRole("button", { name: "Plan the whole app" });
    expect(await submit.evaluate((element) => element === document.activeElement)).toBe(true);
    await p.keyboard.press("Tab");
    expect(await brief.evaluate((element) => element === document.activeElement)).toBe(true);

    await p.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(await planTrigger.evaluate((element) => element === document.activeElement)).toBe(true);

    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto(`${DRILL_BASE}/?view=authoring&page=home`);
    await p.locator(".dr-cv").waitFor({ state: "visible", timeout: 15_000 });
    const sheet = p.locator(".dr-au-plan");
    expect(await sheet.getAttribute("aria-hidden")).toBe("true");
    expect(await sheet.evaluate((element: HTMLElement) => element.inert)).toBe(true);

    const fab = p.getByRole("button", { name: "Open authoring plan" });
    await fab.click();
    const mobileDialog = p.getByRole("dialog", { name: "Authoring checks" });
    await mobileDialog.waitFor();
    expect(await mobileDialog.getAttribute("aria-modal")).toBe("true");
    const close = p.getByRole("button", { name: "Close plan sheet" });
    await expect.poll(() => close.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await sheet.getAttribute("aria-hidden")).toBeNull();
    expect(await sheet.evaluate((element: HTMLElement) => element.inert)).toBe(false);

    await p.keyboard.press("Escape");
    await p.locator(".dr-au-plan.dr-sheet-closed").waitFor();
    await expect.poll(() => fab.evaluate((element) => element === document.activeElement)).toBe(true);

    await fab.click();
    await mobileDialog.waitFor();
    await close.click();
    await expect.poll(() => fab.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await sheet.getAttribute("aria-hidden")).toBe("true");
    expect(await sheet.evaluate((element: HTMLElement) => element.inert)).toBe(true);
  }, 30_000);

  it("gives every native authoring and review field an accessible name", async () => {
    const p = page!;
    await p.setViewportSize({ width: 1440, height: 900 });
    for (const view of ["book", "authoring", "states", "results"]) {
      await p.goto(`${DRILL_BASE}/?view=${view}${view === "authoring" ? "&page=home" : ""}`);
      await p.locator(".dr-body").waitFor();
      if (view === "authoring") await p.locator(".dr-au-canvas").waitFor({ timeout: 15_000 });
      const unlabeled = await p.locator("input,select,textarea").evaluateAll((elements) =>
        elements
          .filter((element) => {
            const control = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
            return !control.getAttribute("aria-label")
              && !control.getAttribute("aria-labelledby")
              && control.labels?.length === 0;
          })
          .map((element) => `${element.tagName.toLowerCase()}.${element.className}`)
      );
      expect(unlabeled, `${view} has unlabeled native fields`).toEqual([]);
    }
  }, 30_000);

  it("keeps every surface inside the viewport at phone, tablet, and desktop widths", async () => {
    const p = page!;
    const widths = [320, 390, 760, 761, 1024, 1440];
    const views = ["book", "authoring", "states", "results"];
    for (const width of widths) {
      await p.setViewportSize({ width, height: 900 });
      for (const view of views) {
        await p.goto(`${DRILL_BASE}/?view=${view}${view === "authoring" ? "&page=home" : ""}`);
        await p.locator(".dr-body").waitFor();
        if (view === "authoring") await p.locator(".dr-au-canvas").waitFor({ timeout: 15_000 });
        // Let responsive reflow and any mount-time status chips settle before
        // measuring. Sampling in the same frame as their async render makes a
        // transient flex width look like persistent overflow.
        await p.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        const overflow = await p.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
          offenders: [...document.querySelectorAll<HTMLElement>(".card,.dr-res,.dr-tablewrap,.dr-au-canvas")]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.left < -1 || rect.right > document.documentElement.clientWidth + 1;
            })
            .map((element) => element.className),
          internal: [...document.querySelectorAll<HTMLElement>(
            ".card,.dr-res,.dr-intro,.dr-au-plan,.dr-au-canvas,.dr-state-card,.dr-finding,.dr-dispatch,.dr-actions"
          )]
            .filter((element) => {
              if (element.offsetParent === null) return false;
              const overflowX = getComputedStyle(element).overflowX;
              return element.scrollWidth > element.clientWidth + 2 && !["auto", "scroll"].includes(overflowX);
            })
            .map((element) => {
              const children = [...element.children].map((child) => {
                const node = child as HTMLElement;
                const rect = node.getBoundingClientRect();
                return `${node.className || node.tagName}:${Math.round(rect.left)}-${Math.round(rect.right)}:${node.clientWidth}/${node.scrollWidth}`;
              }).join("|");
              return `${element.className} (${element.clientWidth}/${element.scrollWidth}) [${children}]`;
            }),
          controlOverlaps: [...document.querySelectorAll<HTMLElement>(
            ".dr-actions,.dr-dispatch,.dr-run-launch-actions,.dr-author-controls,.dr-canvas-actions,.dr-rowwrap"
          )].flatMap((container) => {
            const controls = [...container.querySelectorAll<HTMLElement>(
              ":scope > button,:scope > input,:scope > select,:scope > textarea"
            )].filter((control) => control.offsetParent !== null);
            const pairs: string[] = [];
            for (let left = 0; left < controls.length; left++) {
              for (let right = left + 1; right < controls.length; right++) {
                const a = controls[left].getBoundingClientRect();
                const b = controls[right].getBoundingClientRect();
                const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (overlapWidth > 1 && overlapHeight > 1) {
                  pairs.push(`${controls[left].textContent || controls[left].tagName}/${controls[right].textContent || controls[right].tagName}`);
                }
              }
            }
            return pairs;
          })
        }));
        expect(overflow.scroll, `${width}px ${view}: ${overflow.offenders.join(", ")}`).toBeLessThanOrEqual(overflow.client + 1);
        expect(overflow.offenders, `${width}px ${view}`).toEqual([]);
        expect(overflow.internal, `${width}px ${view} internal overflow`).toEqual([]);
        expect(overflow.controlOverlaps, `${width}px ${view} overlapping controls`).toEqual([]);

        if (view === "authoring" && width <= 760) {
          const sheet = p.locator(".dr-au-plan");
          const liveBrowser = p.locator(".dr-cv-live");
          await liveBrowser.waitFor({ state: "visible", timeout: 15_000 });
          await p.locator(".dr-fab").waitFor({ state: "visible", timeout: 10_000 });
          expect(await sheet.getAttribute("class")).toContain("dr-sheet-closed");
          const browserBox = await liveBrowser.boundingBox();
          const sheetBox = await sheet.boundingBox();
          expect(browserBox).toBeTruthy();
          expect(sheetBox).toBeTruthy();
          expect(browserBox!.y).toBeLessThan(900);
          expect(sheetBox!.y).toBeGreaterThanOrEqual(899);
        }

        if (view === "results" && width <= 390) {
          const confirm = await p.getByRole("button", { name: "Confirm", exact: true }).first().boundingBox();
          const dismiss = await p.getByRole("button", { name: "Dismiss", exact: true }).first().boundingBox();
          const dispatchSelect = await p.locator(".dr-dispatch select").boundingBox();
          const dispatchButton = await p.locator(".dr-dispatch .btn").boundingBox();
          expect(confirm).toBeTruthy();
          expect(dismiss).toBeTruthy();
          expect(Math.abs(confirm!.y - dismiss!.y), `${width}px findings actions should stay inline`).toBeLessThan(2);
          expect(dispatchSelect).toBeTruthy();
          expect(dispatchButton).toBeTruthy();
          expect(dispatchButton!.y, `${width}px dispatch controls should stack`).toBeGreaterThan(dispatchSelect!.y + dispatchSelect!.height - 1);
        }
      }
    }
    expect(consoleErrors).toEqual([]);
  }, 90_000);
});
