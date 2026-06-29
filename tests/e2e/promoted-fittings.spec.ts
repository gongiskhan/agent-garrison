import { test, expect } from "@playwright/test";

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

// 2026-06-24 — promoted Fittings: the Claude Code primitives presented as
// first-class Fittings with a human description, an explicit contract, and an
// EDITABLE Setup Instructions section. Drives the seeded sandbox
// (~/.garrison-test), never live ~/.claude. The setup-instruction overrides
// persist into GARRISON_SANDBOX, so this test is self-contained per run
// (global-setup wipes it).

test("promoted Fitting detail: human description, contract, and a visible Setup Instructions section", async ({
  page
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  // Navigate from the Compose grid into the detail (proves the card links work).
  await page.goto("/compose");
  await page.getByTestId("promoted-fitting-playwright-cli").click();
  await expect(page).toHaveURL(/\/fitting\/promoted\/playwright-cli$/);

  await expect(page.getByTestId("promoted-detail-playwright-cli")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Browser Automation" })).toBeVisible();
  // Plain-language description present (non-technical reader).
  await expect(page.getByTestId("promoted-detail-playwright-cli")).toContainText("drive a real web browser");
  // Explicit contract.
  await expect(page.getByTestId("promoted-contract-provides")).toBeVisible();
  await expect(page.getByTestId("promoted-contract-consumes")).toBeVisible();

  // The Setup Instructions section is VISIBLE (not hidden behind file editing),
  // with the canonical Playwright two-step baseline.
  await expect(page.getByTestId("setup-instructions")).toBeVisible();
  await expect(page.getByTestId("setup-step-0")).toBeVisible();
  await expect(page.getByTestId("setup-step-1")).toBeVisible();
  await expect(page.getByTestId("setup-step-command-0")).toHaveValue(/playwright/i);

  expect(appErrors(errors)).toEqual([]);
});

test("Setup Instructions: add / edit / reorder / remove, autosaved and persisted across reload", async ({
  page
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  // garrison-browser ships with no setup steps → a clean starting point.
  await page.goto("/fitting/promoted/garrison-browser");
  await expect(page.getByTestId("setup-instructions")).toBeVisible();
  await expect(page.getByTestId("setup-empty")).toBeVisible();

  // ADD step 1 + fill it (text edit autosaves after a debounce).
  await page.getByTestId("setup-step-add").click();
  await expect(page.getByTestId("setup-step-0")).toBeVisible();
  await page.getByTestId("setup-step-label-0").fill("Provision");
  await page.getByTestId("setup-step-command-0").fill("echo provision");
  await expect(page.getByTestId("setup-save-status")).toHaveText(/saved/i);

  // ADD step 2.
  await page.getByTestId("setup-step-add").click();
  await page.getByTestId("setup-step-command-1").fill("echo second");
  await expect(page.getByTestId("setup-save-status")).toHaveText(/saved/i);

  // REORDER — move step 2 above step 1.
  await page.getByTestId("setup-step-up-1").click();
  await expect(page.getByTestId("setup-step-command-0")).toHaveValue("echo second");
  await expect(page.getByTestId("setup-step-command-1")).toHaveValue("echo provision");
  await expect(page.getByTestId("setup-save-status")).toHaveText(/saved/i);

  // RELOAD — the edits persisted to the same field the installer reads.
  await page.reload();
  await expect(page.getByTestId("setup-step-command-0")).toHaveValue("echo second");
  await expect(page.getByTestId("setup-step-command-1")).toHaveValue("echo provision");
  await expect(page.getByTestId("setup-step-label-1")).toHaveValue("Provision");

  // REMOVE both → back to the empty state, persisted.
  await page.getByTestId("setup-step-remove-0").click();
  await page.getByTestId("setup-step-remove-0").click();
  await expect(page.getByTestId("setup-empty")).toBeVisible();
  await expect(page.getByTestId("setup-save-status")).toHaveText(/saved/i);
  await page.reload();
  await expect(page.getByTestId("setup-empty")).toBeVisible();

  expect(appErrors(errors)).toEqual([]);
});

test("clearing every step of a Fitting that HAS a baseline persists empty (does not revert to baseline)", async ({
  page
}) => {
  // `watch` ships a one-step baseline (install yt-dlp + ffmpeg). Removing it must
  // persist an explicit empty — not silently fall back to the authored baseline.
  await page.goto("/fitting/promoted/watch");
  await expect(page.getByTestId("setup-step-0")).toBeVisible();

  await page.getByTestId("setup-step-remove-0").click();
  await expect(page.getByTestId("setup-empty")).toBeVisible();
  await expect(page.getByTestId("setup-save-status")).toHaveText(/saved/i);

  await page.reload();
  await expect(page.getByTestId("setup-empty")).toBeVisible();
});
