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

function onDisk(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
}

// NOTE: the three viewport projects (desktop/tablet/mobile) run serially against
// ONE shared sandbox seeded once by global-setup, so a prior project may have
// already mutated settings.json. Assertions therefore reflect the CURRENT on-disk
// state and force real state changes rather than assuming the seed values.
test("S1 settings: autosave (no save button) persists changes + preserves bespoke keys", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  // Headline: there is NO save button — changes persist automatically.
  await expect(page.getByTestId("settings-save")).toHaveCount(0);

  // documented key renders as a typed (number) control reflecting the on-disk value
  const cleanup = page.getByTestId("setting-cleanupPeriodDays");
  await expect(cleanup).toBeVisible();
  await expect(cleanup).toHaveValue(String(onDisk().cleanupPeriodDays));

  // bespoke keys (never edited here) surface in the Advanced passthrough
  await expect(page.getByTestId("unknown-advisorModel")).toBeVisible();
  await expect(page.getByTestId("unknown-autoMode")).toBeVisible();

  // edit a debounced (number) key and blur -> immediate autosave
  await cleanup.fill("30");
  await cleanup.blur();
  await expect(page.getByTestId("autosave-status")).toHaveText("saved");
  await expect.poll(() => onDisk().cleanupPeriodDays).toBe(30);

  // bespoke keys preserved by value through the merge-write
  expect(onDisk().advisorModel).toBe("opus");
  expect(onDisk().autoMode).toEqual({ environment: ["solo dev"] });

  // a discrete (boolean) control autosaves immediately, no blur. setChecked to the
  // opposite of the current state guarantees a real change event regardless of the
  // value a prior project left on disk.
  const thinking = page.getByTestId("setting-alwaysThinkingEnabled");
  const before = await thinking.isChecked();
  await thinking.setChecked(!before);
  await expect.poll(() => onDisk().alwaysThinkingEnabled).toBe(!before);

  // the number edit and bespoke keys are still intact after the second write
  expect(onDisk().cleanupPeriodDays).toBe(30);
  expect(onDisk().advisorModel).toBe("opus");

  expect(appErrors(errors)).toEqual([]);
});
