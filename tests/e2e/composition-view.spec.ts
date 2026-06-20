import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

// HV8 — the holistic composition view: the Compose grid groups role faculties
// (essential vs optional) AND surfaces the Claude Code components (Skills / Hooks
// / Agent Tools / Plugins) from the live StateModel, with a real enable/disable
// (park) toggle. Drives the seeded sandbox (~/.garrison-test), never live ~/.claude.

test("Compose holistic view: three groups + four component tiles", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/compose");
  // Essential vs optional role groups
  await expect(page.getByRole("heading", { name: "Every agent needs these" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Optional roles" })).toBeVisible();
  // The Claude Code components group + its four tiles, sourced from the StateModel
  await expect(page.getByRole("heading", { name: "Claude Code components" })).toBeVisible();
  for (const surface of ["skill", "hook", "mcp", "plugin"]) {
    await expect(page.getByTestId(`component-tile-${surface}`)).toBeVisible();
  }
  // The Agent Tools (mcp) tile reports a real "enabled" count (the seeded servers)
  await expect(page.getByTestId("component-tile-mcp")).toContainText("enabled");

  expect(appErrors(errors)).toEqual([]);
});

async function ensureEnabled(page: Page, id: string): Promise<void> {
  const toggle = page.getByTestId(`toggle-${id}`);
  if ((await toggle.textContent())?.trim() === "Enable") {
    await toggle.click();
    await expect(page.getByTestId(`presence-${id}`)).toHaveText("enabled");
  }
}

test("Quarters MCPs: enable/disable is a real park move, round-trippable from the UI", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const id = "mcp:hv-demo-mcp";
  await page.goto("/quarters/mcps");
  await expect(page.getByRole("heading", { name: "MCPs", level: 1 })).toBeVisible();
  await expect(page.getByTestId(`primitive-${id}`)).toBeVisible();

  // normalize (a prior failed run may have left it parked)
  await ensureEnabled(page, id);
  await expect(page.getByTestId(`presence-${id}`)).toHaveText("enabled");

  // DISABLE → the row stays (read from active ∪ parked) and flips to parked
  await page.getByTestId(`toggle-${id}`).click();
  await expect(page.getByTestId(`presence-${id}`)).toHaveText("parked");
  await expect(page.getByTestId(`toggle-${id}`)).toHaveText("Enable");

  // ENABLE → back to enabled
  await page.getByTestId(`toggle-${id}`).click();
  await expect(page.getByTestId(`presence-${id}`)).toHaveText("enabled");
  await expect(page.getByTestId(`toggle-${id}`)).toHaveText("Disable");

  // the OTHER seeded server was never touched
  await expect(page.getByTestId("primitive-mcp:sandbox-mcp")).toBeVisible();

  expect(appErrors(errors)).toEqual([]);
});
