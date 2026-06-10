import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { GARRISON_SANDBOX } from "./sandbox";

// W4 — the Workspaces Fitting over the sandboxed dev server.
//
// Self-seeding (the C5 pattern): the workspace layout file is written
// directly into the sandbox GARRISON_HOME view-state dir before page.goto.
// Both panes reference EMBEDDED views that exist in the static registry and
// the default composition's library (own-port fittings aren't running in
// e2e, so they'd only prove the placeholder path).
//
// The seed is re-written at the start of every test because the sandbox is
// seeded once for all three viewport projects and the resize test mutates
// the geometry on disk — without this, later projects would inherit it.

const PANE_A = "artifact-store:list";
const PANE_B = "documents:read";

const SEED_LAYOUT = {
  panes: [
    { ref: PANE_A, x: 0, y: 0, w: 50, h: 100 },
    { ref: PANE_B, x: 50, y: 0, w: 50, h: 100 }
  ]
};

function seedLayout(): void {
  const dir = path.join(GARRISON_SANDBOX, "view-state", "workspaces");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "default.json"),
    JSON.stringify(
      {
        fittingId: "workspaces",
        instanceId: "default",
        updatedAt: new Date().toISOString(),
        state: SEED_LAYOUT
      },
      null,
      2
    )
  );
}

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

test("Workspaces: persisted layout renders two referenced views; pane chrome stays thin", async ({ page }) => {
  const errors = collectErrors(page);
  seedLayout();

  await page.goto("/fitting/workspaces");
  await expect(page.getByTestId("workspace-root")).toBeVisible();

  const panes = page.getByTestId("workspace-pane");
  await expect(panes).toHaveCount(2);
  await expect(page.locator(`[data-testid="workspace-pane"][data-ref="${PANE_A}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid="workspace-pane"][data-ref="${PANE_B}"]`)).toBeVisible();

  // The panes mount the SAME components the views use standalone:
  // artifact-store:list renders its Artifacts browser; documents:read is the
  // real DocumentRead, which (with no document id routed in) reports exactly
  // that.
  const paneA = page.locator(`[data-testid="workspace-pane"][data-ref="${PANE_A}"]`);
  await expect(paneA.getByText("Artifacts", { exact: true })).toBeVisible();
  const paneB = page.locator(`[data-testid="workspace-pane"][data-ref="${PANE_B}"]`);
  await expect(paneB.getByText("No document id in URL")).toBeVisible();

  // Chrome budget: pane header strip <= 28px (target 24).
  const headerBox = await paneA.getByTestId("pane-header").boundingBox();
  expect(headerBox).toBeTruthy();
  const headerHeight = Math.round(headerBox!.height);
  expect(headerHeight).toBeLessThanOrEqual(28);
  console.log(`CHROME_OK ${headerHeight}`);

  expect(appErrors(errors)).toEqual([]);
});

test("Workspaces: corner-drag resize changes geometry and persists with no save action", async ({ page }, testInfo) => {
  // Mouse-drag geometry is asserted on the desktop project only — synthetic
  // pointer drags at the 390px viewport are flaky and prove nothing extra
  // (the persistence path is identical). The render test above still runs on
  // all three projects.
  test.skip(testInfo.project.name !== "desktop-chromium", "drag assertions are desktop-scoped");

  const errors = collectErrors(page);
  seedLayout();

  await page.goto("/fitting/workspaces");
  await expect(page.getByTestId("workspace-root")).toBeVisible();
  const pane = page.locator(`[data-testid="workspace-pane"][data-ref="${PANE_A}"]`);
  await expect(pane).toBeVisible();
  await expect(pane.getByText("Artifacts", { exact: true })).toBeVisible();

  // The fitting surface renders its overview above the view, so the
  // workspace sits below the fold — scroll the handle into the viewport
  // first or the synthetic mouse coordinates land on nothing.
  const handle = pane.getByTestId("pane-resize-handle");
  await handle.scrollIntoViewIfNeeded();

  const before = await pane.boundingBox();
  expect(before).toBeTruthy();

  // Drag the corner handle up-left to shrink the pane. The only persistence
  // is the debounced auto-PUT — wait for it before reloading.
  const handleBox = await handle.boundingBox();
  expect(handleBox).toBeTruthy();
  const startX = handleBox!.x + handleBox!.width / 2;
  const startY = handleBox!.y + handleBox!.height / 2;

  const putLanded = page.waitForResponse(
    (res) => res.url().includes("/api/view-state") && res.request().method() === "PUT" && res.ok()
  );
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 100, startY - 120, { steps: 12 });
  await page.mouse.up();
  await putLanded;

  const after = await pane.boundingBox();
  expect(after).toBeTruthy();
  expect(before!.width - after!.width).toBeGreaterThan(60);
  expect(before!.height - after!.height).toBeGreaterThan(60);

  // Reload: the new geometry must come back from disk — which re-proves
  // there is no save button anywhere on this path.
  await page.reload();
  await expect(page.getByTestId("workspace-root")).toBeVisible();
  const reloadedPane = page.locator(`[data-testid="workspace-pane"][data-ref="${PANE_A}"]`);
  await expect(reloadedPane).toBeVisible();
  const persisted = await reloadedPane.boundingBox();
  expect(persisted).toBeTruthy();
  expect(Math.abs(persisted!.width - after!.width)).toBeLessThanOrEqual(8);
  expect(Math.abs(persisted!.height - after!.height)).toBeLessThanOrEqual(8);

  await expect(page.getByTestId("workspace-pane")).toHaveCount(2);
  await page.getByTestId("workspace-root").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/autothing/evidence/workspaces-panes.png", fullPage: false });
  console.log("SCREENSHOT docs/autothing/evidence/workspaces-panes.png");
  console.log("WORKSPACE_PANES_OK");

  expect(appErrors(errors)).toEqual([]);
});
