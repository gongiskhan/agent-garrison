import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_SANDBOX } from "./sandbox";

const userClaudeMd = path.join(CLAUDE_SANDBOX, "CLAUDE.md");

test("S4 memory: edit + save user CLAUDE.md writes to disk", async ({ page }) => {
  await page.goto("/memory");
  await expect(page.getByRole("heading", { name: /Memory/, level: 1 })).toBeVisible();

  const editor = page.getByTestId("claude-md-editor");
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("Sandbox user CLAUDE.md");

  // Replace the content. pressSequentially fires per-keystroke input events so the
  // React-controlled textarea's onChange updates state (plain fill() did not).
  const next = "EDITED-BY-E2E-WALKTHROUGH";
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.press("Delete");
  await editor.pressSequentially(next);
  await expect(editor).toHaveValue(next); // confirm the change registered

  await page.getByTestId("claude-md-save").click();
  await expect(page.getByTestId("claude-md-saved")).toBeVisible();

  expect(fs.readFileSync(userClaudeMd, "utf8")).toBe(next);
});
