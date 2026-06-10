import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_SANDBOX } from "./sandbox";

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

test("Quarters Scripts: create → edit → delete a command (commands + rules listed)", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const NAME = "deploy-note-e2e";

  await page.goto("/quarters/scripts");
  await expect(page.getByRole("heading", { name: "Scripts", level: 1 })).toBeVisible();
  // both seeded surfaces are listed
  await expect(page.getByTestId("primitive-command:example-command")).toBeVisible();
  await expect(page.getByTestId("primitive-rule:example-rule")).toBeVisible();
  // two create buttons (one per surface)
  await expect(page.getByTestId("create-command")).toBeVisible();
  await expect(page.getByTestId("create-rule")).toBeVisible();

  // --- CREATE a command ---
  await page.getByTestId("create-command").click();
  await expect(page.getByTestId("file-form")).toBeVisible();
  await page.getByTestId("file-name").fill(NAME);
  await page.getByTestId("file-save").click();
  await expect(page.getByTestId(`primitive-command:${NAME}`)).toBeVisible();

  // --- EDIT ---
  await page.getByTestId(`edit-command:${NAME}`).click();
  await expect(page.getByTestId("file-content")).toHaveValue(new RegExp(NAME));
  await page.getByTestId("file-content").fill("# /" + NAME + "\n\nedited prompt body\n");
  await page.getByTestId("file-save").click();
  await expect(page.getByTestId(`primitive-command:${NAME}`)).toBeVisible();

  // --- DELETE ---
  await page.getByTestId(`delete-command:${NAME}`).click();
  await page.getByTestId("confirm-action").click();
  await expect(page.getByTestId(`primitive-command:${NAME}`)).toHaveCount(0);

  expect(appErrors(errors)).toEqual([]);
});

test("Quarters Hooks: hand-authored editable, fitting-owned read-only, create→edit→delete", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/quarters/hooks");
  await expect(page.getByRole("heading", { name: "Hooks", level: 1 })).toBeVisible();

  // hand-authored (untagged) group is editable + removable
  const hand = page.getByTestId("primitive-hook:SessionStart#0");
  await expect(hand).toBeVisible();
  await expect(page.getByTestId("edit-hook:SessionStart#0")).toBeVisible();
  await expect(page.getByTestId("delete-hook:SessionStart#0")).toBeVisible();

  // fitting-owned group is READ-ONLY: no edit, no delete, shows provenance
  const owned = page.getByTestId("primitive-hook:Stop#0");
  await expect(owned).toBeVisible();
  await expect(owned.getByText(/fitting-owned/)).toBeVisible();
  await expect(page.getByTestId("edit-hook:Stop#0")).toHaveCount(0);
  await expect(page.getByTestId("delete-hook:Stop#0")).toHaveCount(0);

  // editing the hand-authored hook prefills its command
  await page.getByTestId("edit-hook:SessionStart#0").click();
  await expect(page.getByTestId("hook-form")).toBeVisible();
  await expect(page.getByTestId("hook-command")).toHaveValue("echo hand-authored");
  await page.getByTestId("drawer-close").click();

  // --- CREATE a new hook on a fresh event ---
  await page.getByTestId("create-hook").click();
  await expect(page.getByTestId("hook-form")).toBeVisible();
  await page.getByTestId("hook-event").fill("Notification");
  await page.getByTestId("hook-command").fill("echo notify");
  await page.getByTestId("hook-save").click();
  await expect(page.getByTestId("primitive-hook:Notification#0")).toBeVisible();

  // --- EDIT it ---
  await page.getByTestId("edit-hook:Notification#0").click();
  await expect(page.getByTestId("hook-command")).toHaveValue("echo notify");
  await page.getByTestId("hook-command").fill("echo notify-edited");
  await page.getByTestId("hook-save").click();
  await expect(page.getByTestId("primitive-hook:Notification#0")).toBeVisible();

  // --- DELETE it ---
  await page.getByTestId("delete-hook:Notification#0").click();
  await page.getByTestId("confirm-action").click();
  await expect(page.getByTestId("primitive-hook:Notification#0")).toHaveCount(0);

  // seeded groups intact
  await expect(page.getByTestId("primitive-hook:SessionStart#0")).toBeVisible();
  await expect(page.getByTestId("primitive-hook:Stop#0")).toBeVisible();

  expect(appErrors(errors)).toEqual([]);
});

test("Quarters Plugins: uninstall (remove) a plugin from the UI", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const KEY = "frontend-design@claude-plugins-official";

  // Re-seed the plugin manifest: the sandbox is seeded ONCE for all three
  // viewport projects, and this test consumes the entry — without this, the
  // second and third projects find nothing to remove (flip-relative rule).
  fs.writeFileSync(
    path.join(CLAUDE_SANDBOX, "plugins", "installed_plugins.json"),
    JSON.stringify(
      {
        version: 2,
        plugins: {
          [KEY]: [{ scope: "user", version: "08de64fff891", installPath: "/sandbox/fd" }]
        }
      },
      null,
      2
    )
  );

  await page.goto("/quarters/plugins");
  await expect(page.getByRole("heading", { name: "Plugins", level: 1 })).toBeVisible();
  const row = page.getByTestId(`primitive-plugin:${KEY}`);
  await expect(row).toBeVisible();
  // remove-only: a Remove button but no Edit and no Promote/Park
  await expect(page.getByTestId(`delete-plugin:${KEY}`)).toBeVisible();
  await expect(page.getByTestId(`edit-plugin:${KEY}`)).toHaveCount(0);

  // --- REMOVE --- (confirm warns it edits Claude Code's manifest)
  await page.getByTestId(`delete-plugin:${KEY}`).click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expect(page.getByTestId("confirm-dialog").getByText(/installed_plugins\.json/)).toBeVisible();
  await page.getByTestId("confirm-action").click();
  await expect(page.getByTestId(`primitive-plugin:${KEY}`)).toHaveCount(0);

  expect(appErrors(errors)).toEqual([]);
});
