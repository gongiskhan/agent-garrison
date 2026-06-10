import { test, expect } from "@playwright/test";

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

test("Quarters Logs + Sessions: read-only tailing over the seeded ~/.claude", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  // Logs: list the seeded log files and tail one of them.
  await page.goto("/quarters/logs");
  await expect(page.getByRole("heading", { name: "Logs", level: 1 })).toBeVisible();
  await expect(page.getByTestId("readonly-logs")).toBeVisible();
  const daemonRow = page.getByTestId("logentry-daemon.log");
  await expect(daemonRow).toBeVisible();
  await daemonRow.click();
  const logsTail = page.getByTestId("tail-logs");
  await expect(logsTail).toBeVisible();
  await expect(logsTail).toContainText("daemon serving");

  // A nested log file is also surfaced.
  await expect(page.getByTestId("logentry-logs/security/audit.log")).toBeVisible();

  // Sessions: list the seeded record + transcript and tail one.
  await page.goto("/quarters/sessions");
  await expect(page.getByRole("heading", { name: "Sessions", level: 1 })).toBeVisible();
  await expect(page.getByTestId("readonly-sessions")).toBeVisible();
  await expect(page.getByTestId("logentry-projects/-sandbox-proj/transcript.jsonl")).toBeVisible();
  const sessionRow = page.getByTestId("logentry-sessions/9937.json");
  await expect(sessionRow).toBeVisible();
  await sessionRow.click();
  const sessTail = page.getByTestId("tail-sessions");
  await expect(sessTail).toBeVisible();
  await expect(sessTail).toContainText("9937");

  expect(appErrors(errors)).toEqual([]);
});
