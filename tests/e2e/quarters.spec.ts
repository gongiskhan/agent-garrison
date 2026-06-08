import { test, expect } from "@playwright/test";

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

test("Quarters: index lists categories over the real ~/.claude; surfaces resolve", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  // Index renders all 10 category cards with state.
  await page.goto("/quarters");
  await expect(page.getByRole("heading", { name: "Quarters", level: 1 })).toBeVisible();
  await expect(page.getByTestId("quarters-grid")).toBeVisible();
  for (const slug of ["settings", "context", "skills", "hooks", "mcps", "plugins", "scripts", "plans", "logs", "sessions"]) {
    await expect(page.getByTestId(`quarters-card-${slug}`)).toBeVisible();
  }

  // Skills surface: the seeded hand-authored skill is loose with a Promote action.
  await page.goto("/quarters/skills");
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  const skillRow = page.getByTestId("primitive-skill:garrison-memory");
  await expect(skillRow).toBeVisible();
  await expect(skillRow.getByText("loose")).toBeVisible();
  await expect(page.getByTestId("action-skill:garrison-memory")).toHaveText("Promote");

  // MCP surface: the seeded server is listed (loose, no APM ownership model).
  await page.goto("/quarters/mcps");
  await expect(page.getByTestId("primitive-mcp:sandbox-mcp")).toBeVisible();

  // Plans surface: the seeded plan is listed and opens in the editor. (No other
  // spec mutates ~/.claude/plans, so the seeded content is stable.)
  await page.goto("/quarters/plans");
  await page.getByTestId("plan-example-plan.md").click();
  await expect(page.getByTestId("plan-editor")).toHaveValue(/Example plan/);

  // Context surface loads the CLAUDE.md editor. Content is NOT asserted here —
  // the shared sandbox is mutated by the memory spec when specs run as a suite,
  // so this asserts the surface resolves, not a specific body.
  await page.goto("/quarters/context");
  await expect(page.getByRole("heading", { name: "Context", level: 1 })).toBeVisible();
  await expect(page.getByTestId("context-editor")).toBeVisible();

  // Logs surface: read-only.
  await page.goto("/quarters/logs");
  await expect(page.getByTestId("readonly-logs")).toBeVisible();

  expect(appErrors(errors)).toEqual([]);
});
