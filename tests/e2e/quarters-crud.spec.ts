import { test, expect } from "@playwright/test";

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

// Self-contained MCP CRUD round-trip against the seeded sandbox. Uses a UNIQUE
// fixture name and removes it at the end, so it neither depends on suite ordering
// nor leaves residue another spec asserts against (the seeded `sandbox-mcp` is
// never touched).
test("Quarters MCPs: add → edit → remove an MCP server from the UI", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const NAME = "ctx7-e2e";

  await page.goto("/quarters/mcps");
  await expect(page.getByRole("heading", { name: "MCPs", level: 1 })).toBeVisible();
  // seeded server present and untouched
  await expect(page.getByTestId("primitive-mcp:sandbox-mcp")).toBeVisible();

  // --- ADD ---
  await page.getByTestId("create-mcp").click();
  await expect(page.getByTestId("mcp-form")).toBeVisible();
  await page.getByTestId("mcp-name").fill(NAME);
  await page.getByTestId("mcp-command").fill("npx");
  await page.getByTestId("mcp-args").fill("-y\n@upstash/context7-mcp");
  await page.getByTestId("mcp-save").click();

  const row = page.getByTestId(`primitive-mcp:${NAME}`);
  await expect(row).toBeVisible();

  // --- EDIT --- (reopen, change a field, save; row persists)
  await page.getByTestId(`edit-mcp:${NAME}`).click();
  await expect(page.getByTestId("mcp-form")).toBeVisible();
  await expect(page.getByTestId("mcp-command")).toHaveValue("npx");
  await page.getByTestId("mcp-command").fill("uvx");
  await page.getByTestId("mcp-save").click();
  await expect(page.getByTestId(`primitive-mcp:${NAME}`)).toBeVisible();

  // --- REMOVE --- (confirm dialog → gone)
  await page.getByTestId(`delete-mcp:${NAME}`).click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-action").click();
  await expect(page.getByTestId(`primitive-mcp:${NAME}`)).toHaveCount(0);

  // seeded server still present
  await expect(page.getByTestId("primitive-mcp:sandbox-mcp")).toBeVisible();

  expect(appErrors(errors)).toEqual([]);
});

test("Quarters Skills: create → edit → delete a loose skill from the UI", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const NAME = "demo-skill-e2e";

  await page.goto("/quarters/skills");
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  // seeded loose skill keeps its Promote action (not disturbed by CRUD)
  await expect(page.getByTestId("action-skill:garrison-memory")).toHaveText("Promote");

  // --- CREATE --- (name prefills the SKILL.md template)
  await page.getByTestId("create-skill").click();
  await expect(page.getByTestId("file-form")).toBeVisible();
  await page.getByTestId("file-name").fill(NAME);
  await expect(page.getByTestId("file-content")).toHaveValue(new RegExp(`name: ${NAME}`));
  await page.getByTestId("file-save").click();
  await expect(page.getByTestId(`primitive-skill:${NAME}`)).toBeVisible();

  // --- EDIT --- (body loads, change it, save)
  await page.getByTestId(`edit-skill:${NAME}`).click();
  await expect(page.getByTestId("file-form")).toBeVisible();
  await expect(page.getByTestId("file-content")).toHaveValue(new RegExp(`name: ${NAME}`));
  await page.getByTestId("file-content").fill("---\nname: " + NAME + "\ndescription: edited\n---\n# edited body\n");
  await page.getByTestId("file-save").click();
  await expect(page.getByTestId(`primitive-skill:${NAME}`)).toBeVisible();

  // --- DELETE --- (loose → removable directly)
  await page.getByTestId(`delete-skill:${NAME}`).click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-action").click();
  await expect(page.getByTestId(`primitive-skill:${NAME}`)).toHaveCount(0);

  // seeded skill still present
  await expect(page.getByTestId("primitive-skill:garrison-memory")).toBeVisible();

  expect(appErrors(errors)).toEqual([]);
});
