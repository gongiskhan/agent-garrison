import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_SANDBOX } from "./sandbox";

const skills = path.join(CLAUDE_SANDBOX, "skills");

test("S2 install: green-field install of a skill + brown-field adopt of a pre-existing one", async ({ page }) => {
  await page.goto("/armory");
  await expect(page.getByTestId("claude-install-section")).toBeVisible();

  // ---- green-field install: tier-classifier is NOT pre-seeded ----
  await page.getByTestId("install-tier-classifier").click();
  await expect(page.getByTestId("installed-row-tier-classifier")).toBeVisible();
  // its skill files landed in the sandbox ~/.claude
  expect(fs.existsSync(path.join(skills, "tier-classifier", "SKILL.md"))).toBe(true);

  // ---- brown-field adopt: garrison-memory already exists on disk (unmanaged) ----
  // memory's target (skills/garrison-memory) collides -> Install yields Adopt.
  await page.getByTestId("install-memory").click();
  const adopt = page.getByTestId("adopt-memory");
  await expect(adopt).toBeVisible();
  await adopt.click();
  await expect(page.getByTestId("installed-row-memory")).toBeVisible();
  // adopt did not overwrite the pre-existing bytes
  expect(fs.readFileSync(path.join(skills, "garrison-memory", "SKILL.md"), "utf8")).toContain("pre-existing on disk");

  // ---- uninstall the green-field one ----
  await page.getByTestId("uninstall-tier-classifier").click();
  await expect(page.getByTestId("installed-row-tier-classifier")).toHaveCount(0);
  expect(fs.existsSync(path.join(skills, "tier-classifier"))).toBe(false);
});
