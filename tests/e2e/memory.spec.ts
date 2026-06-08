import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_SANDBOX } from "./sandbox";

const userClaudeMd = path.join(CLAUDE_SANDBOX, "CLAUDE.md");

// "Memory" was renamed to "Context" under the Quarters pivot. /memory permanently
// redirects to the autosave Context surface (the old Save-button MemoryPanel is
// retired). This spec proves the redirect AND that the Context editor autosaves
// CLAUDE.md to disk with no save button. Robust to the shared sandbox: it writes a
// unique marker and asserts THAT lands, never the seed content (a prior viewport
// project may have already rewritten the file).
test("context: /memory redirects to the autosave Context editor and writes CLAUDE.md to disk", async ({ page }, testInfo) => {
  await page.goto("/memory");
  await expect(page).toHaveURL(/\/quarters\/context$/);
  await expect(page.getByRole("heading", { name: "Context", level: 1 })).toBeVisible();

  // No save button on this surface.
  await expect(page.getByTestId("claude-md-save")).toHaveCount(0);

  const editor = page.getByTestId("context-editor");
  await expect(editor).toBeVisible();

  // Unique per-project marker so the three viewport projects don't collide.
  const next = `EDITED-BY-E2E-${testInfo.project.name}`;
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.press("Delete");
  await editor.pressSequentially(next);
  await expect(editor).toHaveValue(next);

  // Autosave flushes on blur — no save click.
  await editor.blur();
  await expect(page.getByTestId("autosave-status")).toHaveText("saved");

  await expect.poll(() => fs.readFileSync(userClaudeMd, "utf8")).toBe(next);
});
