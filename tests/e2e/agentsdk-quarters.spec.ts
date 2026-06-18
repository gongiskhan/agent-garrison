import { test, expect } from "@playwright/test";

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

// The committed, re-runnable correctness gate for the Quarters-AgentSDK slice
// (sdk-quarters-ok). Drives the live route and asserts the FENCE state, HARNESS
// state, and provider/capability table render — backed by the real fitting fns.
test("Quarters-AgentSDK: renders provider table, FENCE state, and HARNESS state", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/quarters/agentsdk");
  await expect(page.getByRole("heading", { name: "AgentSDK Runtime", level: 1 })).toBeVisible();
  await expect(page.getByTestId("agentsdk-panel")).toBeVisible();

  // THE FENCE: default-deny verdicts render, including at least one BLOCKED row.
  const fence = page.getByTestId("fence-state");
  await expect(fence).toBeVisible();
  await expect(fence.getByText("BLOCKED").first()).toBeVisible();

  // THE HARNESS: the full target shows the claude_code preset.
  const harness = page.getByTestId("harness-state");
  await expect(harness).toBeVisible();
  await expect(harness.getByText("claude_code", { exact: false })).toBeVisible();

  // Providers + capability records: deepseek (text+tools only) and ollama-local listed.
  const providers = page.getByTestId("providers-table");
  await expect(providers.getByText("deepseek", { exact: true })).toBeVisible();
  await expect(providers.getByText("ollama-local", { exact: true })).toBeVisible();

  expect(appErrors(errors)).toEqual([]);
});
