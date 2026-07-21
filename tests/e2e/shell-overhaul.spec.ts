import { test, expect } from "@playwright/test";

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

// 2026-07-02 shell refit: every main shell route renders clean, the Compose
// tiles describe what a Fitting DOES instead of repeating its name, search
// filters the grid, and the sidebar Views statuses carry tone dots. Drives the
// seeded sandbox (~/.garrison-test), never live ~/.claude.

const ROUTES = ["/", "/muster", "/quarters", "/vault", "/connectors", "/coordination", "/settings"];

async function openSidebarIfCollapsed(page: import("@playwright/test").Page) {
  const nav = page.locator("nav.tabs");
  const expand = page.getByRole("button", { name: "Expand sidebar" });
  if ((page.viewportSize()?.width ?? Infinity) < 720) {
    // The server render is expanded; the narrow-viewport effect collapses it
    // after hydration. Wait for that stable rail before exercising the tap.
    await expect(expand).toBeVisible();
    await expand.click();
    await expect(page.getByRole("dialog", { name: "Garrison menu" })).toBeVisible();
  } else if (!(await nav.isVisible().catch(() => false))) {
    await expect(expand).toBeVisible();
    await expand.click();
  }
  await expect(nav).toBeVisible();
}

async function openFittingsTab(page: import("@playwright/test").Page) {
  await page.goto("/muster", { timeout: 60_000 });
  const fittings = page.getByRole("tab", { name: /^Fittings/ });
  await expect(fittings).toBeVisible({ timeout: 30_000 });
  await fittings.click();
}

test("every main shell route renders without console errors", async ({ page }) => {
  // Seven first-visit routes in one pass: under `next dev` each pays a compile
  // on first load, so the budget is per-route latency, not product slowness.
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  for (const route of ROUTES) {
    await page.goto(route, { timeout: 60_000 });
    await openSidebarIfCollapsed(page);
    await expect(
      page.locator("main h1, .skeleton-line, [data-testid='muster-loading']").first()
    ).toBeVisible({ timeout: 30_000 });
  }
  expect(appErrors(errors)).toEqual([]);
});

test("Compose: a stationed tile's sub-line describes the Fitting, not its name again", async ({
  page
}) => {
  await openFittingsTab(page);
  await expect(page.getByTestId("standing-section")).toBeVisible();
  const fitting = page.locator("[data-testid^='standing-fitting-']").first();
  await expect(fitting).toBeVisible();
  const name = (await fitting.locator("[data-testid^='standing-fitting-name-']").textContent())?.trim() ?? "";
  const summary = (await fitting.locator("[data-testid^='standing-fitting-summary-']").textContent())?.trim() ?? "";
  expect(summary).not.toBe("");
  expect(summary, `fitting "${name}" repeats its own name as the description`).not.toBe(name);
});

test("Compose: search filters the Fitting grid", async ({ page }) => {
  await openFittingsTab(page);
  const search = page.getByRole("searchbox", { name: "Search standing Fittings" });
  await expect(search).toBeVisible({ timeout: 30_000 });
  await search.fill("zz-no-such-fitting-zz");
  await expect(page.getByText(/No Fittings match that search/i).first()).toBeVisible({
    timeout: 5000
  });
  await search.fill("memory");
  await expect(page.getByText(/Basic Memory/i).first()).toBeVisible();
});

test("Sidebar: own-port view statuses carry a tone class for the at-a-glance dot", async ({
  page
}) => {
  await page.goto("/", { timeout: 60_000 });
  await openSidebarIfCollapsed(page);
  const toned = page.locator("nav.tabs .ct.tone-live, nav.tabs .ct.tone-down, nav.tabs .ct.tone-off");
  await expect(toned.first()).toBeVisible({ timeout: 30_000 });
});
