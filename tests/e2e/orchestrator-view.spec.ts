import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";

// Deterministic UI test for the Orchestrator COMPOSER own-port view
// (GARRISON-UNIFY-V1 S3). Boots the orchestrator server with a SANDBOXED v2
// routing.json (seeded from the seed config) on a free port, then drives the
// page directly: tray + matrix + rails + try-it render; dragging a target
// card onto the implement×T2-deep cell autosaves (debounced PUT /routing)
// and recompiles policy.json with the new model (acceptance: the composer is
// the ONE place work-routing is configured); the effort dial retunes a
// target through the same autosave path; the try-it strip dry-runs a rail.

const REPO_ROOT = process.cwd();
const SERVER = path.join(REPO_ROOT, "fittings", "seed", "orchestrator", "scripts", "server.mjs");
const SEED = path.join(REPO_ROOT, "fittings", "seed", "orchestrator", "config", "routing.seed.json");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function waitReachable(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`timeout waiting for ${url}`));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

let proc: ChildProcess | null = null;
let baseUrl = "";
let home = "";

test.beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gar-composer-e2e-"));
  const configFile = path.join(dir, "routing.json");
  copyFileSync(SEED, configFile);
  home = path.join(dir, "garrison-home");
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  proc = spawn("node", [SERVER], {
    env: { ...process.env, ORCHESTRATOR_CONFIG: configFile, ORCHESTRATOR_PORT: String(port), GARRISON_HOME: home },
    stdio: "ignore"
  });
  await waitReachable(`${baseUrl}/health`);
});

test.afterAll(() => {
  proc?.kill("SIGTERM");
});

// dnd-kit PointerSensor (activation distance 6px) driven with raw mouse moves.
async function dragTo(page: import("@playwright/test").Page, src: import("@playwright/test").Locator, dst: import("@playwright/test").Locator) {
  const sb = await src.boundingBox();
  const db = await dst.boundingBox();
  if (!sb || !db) throw new Error("drag endpoints not visible");
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2 + 12, sb.y + sb.height / 2 + 12, { steps: 4 });
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 12 });
  await page.mouse.up();
}

const implementRow = (page: import("@playwright/test").Page) =>
  page.locator("table.matrix tbody tr").filter({ has: page.locator(".rh-name", { hasText: /^implement$/ }) });

test("composer renders the whole policy: tray, matrix, work-kind rails, try-it", async ({ page }) => {
  await page.goto(baseUrl);
  await expect(page.locator("h1")).toHaveText("Composer");

  // Targets tray - every seed target is a draggable card.
  const opusCard = page.locator(".tray .tcard").filter({ hasText: "cc-opus-high" });
  await expect(opusCard).toBeVisible();
  expect(await page.locator(".tray .tcard:not(.add)").count()).toBeGreaterThanOrEqual(10);
  // Every target card shows its runtime + auth mode (D29 / S9).
  await expect(opusCard.locator(".tcard-runtime")).toBeVisible();
  await expect(opusCard.locator(".tcard-auth")).toHaveText("subscription");
  // The fast agent-sdk target is present and shows its runtime + auth mode.
  const fastCard = page.locator(".tray .tcard").filter({ hasText: "agent-sdk-haiku-fast" });
  await expect(fastCard.locator(".tcard-runtime")).toContainText("agent-sdk");
  await expect(fastCard.locator(".tcard-auth")).toHaveText("subscription");

  // Matrix - 18 task types × 3 tier columns, resolved tokens in every cell.
  await expect(page.locator("table.matrix thead .ch-name", { hasText: "T2-deep" })).toBeVisible();
  expect(await page.locator("table.matrix tbody tr").count()).toBe(18);
  expect(await implementRow(page).locator("td.cell").count()).toBe(3);

  // Work-kind rails - one rail per seed work kind, default badge on full-feature.
  expect(await page.locator(".rail").count()).toBe(4);
  await expect(page.locator(".rail").filter({ hasText: "full-feature" }).locator(".rail-badge")).toHaveText("default");

  // Try-it strip present.
  await expect(page.locator(".tryit-input")).toBeVisible();
});

test("dragging a target onto implement×T2 autosaves and recompiles policy.json with the new model", async ({ page }, testInfo) => {
  // A mouse drag needs the tray card and the target cell on screen at once;
  // at phone width the T2 column is inside the matrix's own horizontal
  // scroll, off-viewport. Phones assign via the TouchSensor (long-press),
  // which synthetic mouse events can't drive - covered on desktop + tablet.
  const vw = page.viewportSize()?.width ?? 0;
  test.skip(vw < 700, "drag-assign is exercised on desktop/tablet viewports");
  await page.goto(baseUrl);
  await expect(page.locator("h1")).toHaveText("Composer");

  // Seed: implement×T2-deep = cc-opus-high (model opus). Drag cc-sonnet-med onto it.
  const card = page.locator(".tray .tcard").filter({ hasText: "cc-sonnet-med" }).locator(".tcard-grab");
  const cell = implementRow(page).locator("td.cell").nth(2); // tiers: T0-trivial, T1-standard, T2-deep
  const put = page.waitForResponse(
    (r) => r.url().includes("/routing") && r.request().method() === "PUT" && r.ok(),
    { timeout: 10000 } // autosave debounce is 800ms
  );
  await dragTo(page, card, cell);
  await put;

  // The document round-trips: the cell now names the dropped target...
  const routing = await (await page.request.get(`${baseUrl}/routing`)).json();
  const prof = routing.config.profiles[routing.config.activeProfile];
  expect(prof.matrix.rows.implement.cells["T2-deep"]).toBe("cc-sonnet-med");

  // ...and the compiled policy.json (what the gateway actually reads) changed model.
  const policy = JSON.parse(readFileSync(path.join(home, "orchestrator", "policy.json"), "utf8"));
  expect(policy.matrix.implement["T2-deep"].targetId).toBe("cc-sonnet-med");
  expect(policy.matrix.implement["T2-deep"].model).toBe("sonnet");

  const shot = testInfo.outputPath("composer-drag.png");
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`[orchestrator-view] screenshot: ${shot}`);
});

test("the effort dial retunes a target through the same autosave path", async ({ page }) => {
  await page.goto(baseUrl);
  const card = page.locator(".tray .tcard").filter({ hasText: "cc-haiku-low" });
  await expect(card.locator(".dial .seg.on")).toHaveText("low");
  const put = page.waitForResponse(
    (r) => r.url().includes("/routing") && r.request().method() === "PUT" && r.ok(),
    { timeout: 10000 }
  );
  await card.locator(".dial .seg", { hasText: /^medium$/ }).click();
  await put;
  await expect(card.locator(".dial .seg.on")).toHaveText("medium");
  const routing = await (await page.request.get(`${baseUrl}/routing`)).json();
  const target = routing.config.targets.find((t: { id: string }) => t.id === "cc-haiku-low");
  expect(target.effort).toBe("medium");
});

test("try-it dry-runs a request into a classified, fully-resolved rail", async ({ page }) => {
  await page.goto(baseUrl);
  await page.locator(".tryit-input").fill("implement a login page with tests");
  await page.getByRole("button", { name: "Dry run" }).click();
  await expect(page.locator(".tryit-chain")).toBeVisible({ timeout: 10000 });
  // Classified chain pills: kind + tier + type.
  await expect(page.locator(".tryit-chain .pill", { hasText: "kind:" })).toBeVisible();
  await expect(page.locator(".tryit-chain .pill", { hasText: "tier:" })).toBeVisible();
  // The rail resolves every pipeline phase; plan-included phases carry a target.
  expect(await page.locator(".tryit-rail .tchip").count()).toBeGreaterThan(0);
  expect(await page.locator(".tryit-rail .tchip.on .tchip-target").count()).toBeGreaterThan(0);
});
