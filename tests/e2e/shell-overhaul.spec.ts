import { test, expect } from "@playwright/test";

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

// 2026-07-02 shell refit: every main shell route renders clean, the Compose
// tiles describe what a Fitting DOES instead of repeating its name, search
// filters the grid, and the sidebar Views statuses carry tone dots. Drives the
// seeded sandbox (~/.garrison-test), never live ~/.claude.

const ROUTES = ["/", "/compose", "/quarters", "/vault", "/connectors", "/coordination", "/settings"];

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
    await expect(page.locator("nav.tabs"), `sidebar visible on ${route}`).toBeVisible();
    await expect(page.locator(".head h1, .skeleton-line").first()).toBeVisible();
  }
  expect(appErrors(errors)).toEqual([]);
});

test("Compose: a stationed tile's sub-line describes the Fitting, not its name again", async ({
  page
}) => {
  await page.goto("/compose", { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Agent faculties" })).toBeVisible({
    timeout: 30_000
  });
  const tiles = page.locator(".station-tile");
  await expect(tiles.first()).toBeVisible();
  const count = await tiles.count();
  let checked = 0;
  for (let i = 0; i < count; i++) {
    const tile = tiles.nth(i);
    const name = (await tile.locator(".t-nm").textContent())?.trim() ?? "";
    const sub = (await tile.locator(".t-fit").textContent())?.trim() ?? "";
    if (!sub) continue;
    expect(sub, `tile "${name}" repeats its own name as the sub-line`).not.toBe(name);
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
});

test("Compose: search filters the Fitting grid", async ({ page }) => {
  await page.goto("/compose", { timeout: 60_000 });
  const search = page.getByPlaceholder(/Search every Faculty/i);
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
  const toned = page.locator("nav.tabs .ct.tone-live, nav.tabs .ct.tone-down, nav.tabs .ct.tone-off");
  await expect(toned.first()).toBeVisible({ timeout: 30_000 });
});
