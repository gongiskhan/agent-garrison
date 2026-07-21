import { test, expect } from "@playwright/test";

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

// The committed, re-runnable correctness gate for the Quarters-AgentSDK slice
// (sdk-quarters-ok). Drives the live route and asserts the runtime-freedom note,
// HARNESS state, and provider/capability/auth-mode table render — backed by the
// real fitting fns.
test("Quarters-AgentSDK: renders provider table, auth modes, and HARNESS state", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/quarters/agentsdk");
  await expect(page.getByRole("heading", { name: "AgentSDK Runtime", level: 1 })).toBeVisible();
  await expect(page.getByTestId("agentsdk-panel")).toBeVisible();

  // Runtime freedom (D29): first-class routable, no fence.
  const note = page.getByTestId("runtime-note");
  await expect(note).toBeVisible();
  await expect(note.getByText("first-class", { exact: false })).toBeVisible();
  await expect(page.getByTestId("fence-state")).toHaveCount(0);

  // THE HARNESS: the full target shows the claude_code preset.
  const harness = page.getByTestId("harness-state");
  await expect(harness).toBeVisible();
  await expect(harness.getByText("claude_code", { exact: false })).toBeVisible();

  // Providers + capability records + auth mode: the Anthropic subscription provider
  // and third-party endpoints are listed with their auth mode.
  const providers = page.getByTestId("providers-table");
  await expect(providers.getByText("deepseek", { exact: true })).toBeVisible();
  await expect(providers.getByText("ollama-local", { exact: true })).toBeVisible();
  await expect(page.getByTestId("authmode-anthropic")).toHaveText("subscription");
  await expect(page.getByTestId("authmode-ollama-local")).toHaveText("local");

  expect(appErrors(errors)).toEqual([]);
});
