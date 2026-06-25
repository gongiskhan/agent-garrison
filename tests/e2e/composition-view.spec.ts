import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

// 2026-06-24 — the Compose grid groups faculties under two headers, Agent
// faculties and Dev faculties (the display tier), and the former "Claude Code
// components" group (Skills / Hooks / Agent Tools / Plugins) is REVERSED: those
// primitives now appear as first-class promoted Fittings under their capability
// faculty, never as a primitive-typed tile. Drives the seeded sandbox
// (~/.garrison-test), never live ~/.claude.

test("Compose: faculties under Agent/Dev headers; promoted Fittings replace the primitive-typed group", async ({
  page
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/compose");
  // The two display-tier headers.
  await expect(page.getByRole("heading", { name: "Agent faculties" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dev faculties" })).toBeVisible();

  // The old primitive-typed group + its four tiles are GONE.
  await expect(page.getByRole("heading", { name: "Claude Code components" })).toHaveCount(0);
  for (const surface of ["skill", "hook", "mcp", "plugin"]) {
    await expect(page.getByTestId(`component-tile-${surface}`)).toHaveCount(0);
  }

  // Promoted Fittings render as first-class cards under their capability faculty.
  await expect(page.getByTestId("capability-faculty-building")).toBeVisible();
  await expect(page.getByTestId("capability-faculty-knowledge")).toBeVisible();
  await expect(page.getByTestId("promoted-fitting-playwright-cli")).toBeVisible();
  // The card shows a human title, never the primitive type.
  await expect(page.getByTestId("promoted-fitting-playwright-cli")).toContainText("Browser Automation");

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
