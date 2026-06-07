import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_SANDBOX } from "./sandbox";

const settingsFile = path.join(CLAUDE_SANDBOX, "settings.json");

function appErrors(errors: string[]): string[] {
  return errors.filter(
    (e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e)
  );
}

test("S1 settings: typed controls + bespoke passthrough; edit/save preserves bespoke keys", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  // documented key renders as a typed (number) control with the on-disk value
  const cleanup = page.getByTestId("setting-cleanupPeriodDays");
  await expect(cleanup).toBeVisible();
  await expect(cleanup).toHaveValue("365");

  // bespoke keys surface in the Advanced (unmanaged) passthrough
  await expect(page.getByTestId("unknown-advisorModel")).toBeVisible();
  await expect(page.getByTestId("unknown-autoMode")).toBeVisible();

  // edit a documented key and save
  await cleanup.fill("30");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("saved-flag")).toBeVisible();

  // on-disk settings.json updated AND bespoke keys preserved by value
  const disk = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  expect(disk.cleanupPeriodDays).toBe(30);
  expect(disk.advisorModel).toBe("opus");
  expect(disk.autoMode).toEqual({ environment: ["solo dev"] });

  expect(appErrors(errors)).toEqual([]);
});
