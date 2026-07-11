import { test, expect } from "@playwright/test";

// GARRISON-RUNTIMES-V1 S7 (P7/D6): Quarters sections follow the composition.
// Multi-runtime (the default composition): every runtime renders as a
// collapsible section and ALL start collapsed; expand state persists locally.
// Single-runtime (the committed e2e-solo fixture composition, reached via the
// ?composition= passthrough): the classic expanded index, current look
// preserved — no section chrome at all.

test("multi-runtime: all sections collapsed by default; expand persists; deep grid intact inside", async ({ page }) => {
  await page.goto("/quarters");
  await expect(page.getByRole("heading", { name: "Quarters", level: 1 })).toBeVisible();

  // One section per selected runtime, all collapsed (no grid, no generic cards).
  for (const rid of ["claude-code-runtime", "codex-runtime", "gemini-runtime"]) {
    const toggle = page.getByTestId(`quarters-section-toggle-${rid}`);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  }
  await expect(page.getByTestId("quarters-grid")).toHaveCount(0);

  // Expand Claude Code: the classic deep grid renders unchanged inside.
  await page.getByTestId("quarters-section-toggle-claude-code-runtime").click();
  await expect(page.getByTestId("quarters-grid")).toBeVisible();
  await expect(page.getByTestId("quarters-card-settings")).toBeVisible();

  // Expand codex: generic-tier cards link to the descriptor categories.
  await page.getByTestId("quarters-section-toggle-codex-runtime").click();
  await expect(page.getByTestId("quarters-card-codex-runtime-settings")).toBeVisible();
  await expect(page.getByTestId("quarters-card-codex-runtime-logs")).toBeVisible();

  // Expand state persists across a reload (localStorage).
  await page.reload();
  await expect(page.getByTestId("quarters-section-toggle-claude-code-runtime")).toHaveAttribute(
    "aria-expanded",
    "true"
  );
  await expect(page.getByTestId("quarters-grid")).toBeVisible();

  // Collapse again — persisted too.
  await page.getByTestId("quarters-section-toggle-claude-code-runtime").click();
  await page.reload();
  await expect(page.getByTestId("quarters-section-toggle-claude-code-runtime")).toHaveAttribute(
    "aria-expanded",
    "false"
  );
});

test("corrupted expand-state localStorage (JSON null) never crashes the index", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("quarters.sections.expanded", "null"));
  await page.goto("/quarters");
  await expect(page.getByTestId("quarters-section-toggle-claude-code-runtime")).toBeVisible();
  // still toggles fine
  await page.getByTestId("quarters-section-toggle-claude-code-runtime").click();
  await expect(page.getByTestId("quarters-grid")).toBeVisible();
});

test("single-runtime: the classic expanded index, no section chrome", async ({ page }) => {
  await page.goto("/quarters?composition=e2e-solo");
  await expect(page.getByRole("heading", { name: "Quarters", level: 1 })).toBeVisible();
  // The classic grid renders directly — expanded, current look preserved.
  await expect(page.getByTestId("quarters-grid")).toBeVisible();
  await expect(page.getByTestId("quarters-card-settings")).toBeVisible();
  // No collapsible section chrome in the single-runtime state.
  await expect(page.getByTestId("quarters-section-toggle-claude-code-runtime")).toHaveCount(0);
});

test("generic runtime page renders from the descriptor over the REAL native file", async ({ page }) => {
  await page.goto("/quarters/codex-runtime/settings");
  await expect(page.getByRole("heading", { name: /codex · settings/ })).toBeVisible();
  // Monaco mounts with the real config.toml content (model key present on this box).
  await expect(page.locator(".runtime-file-path")).toHaveText(/config\.toml/);
});
