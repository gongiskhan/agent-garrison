import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { GARRISON_SANDBOX } from "./sandbox";

// The dashboard Board panel (GarrisonHome.tsx BoardPanel) fetches
// GET /api/board/summary, which reads <board root>/cards/*/card.json off
// disk. The e2e sandbox server's env sets GARRISON_HOME to GARRISON_SANDBOX
// (playwright.config.ts) and never sets GARRISON_KANBAN_DIR, so the board
// root falls back to <GARRISON_SANDBOX>/kanban-loop - exactly the
// "testability" hook the brief asks GARRISON_KANBAN_DIR to provide. Seeding
// fixture cards there drives both UI states through the real running app,
// no second server instance needed.

const BOARD_DIR = path.join(GARRISON_SANDBOX, "kanban-loop");
const UI_FITTINGS_DIR = path.join(GARRISON_SANDBOX, "ui-fittings");

function writeCard(id: string, card: Record<string, unknown>): void {
  const dir = path.join(BOARD_DIR, "cards", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "card.json"), JSON.stringify({ id, ...card }));
}

test.afterEach(() => {
  fs.rmSync(BOARD_DIR, { recursive: true, force: true });
  fs.rmSync(UI_FITTINGS_DIR, { recursive: true, force: true });
});

test("Board panel: quiet idle state when the board has nothing running or parked", async ({ page }) => {
  await page.goto("/", { timeout: 60_000 });
  const panel = page.locator('.dash-panels [data-testid="board-panel"]');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText("Board idle");
});

test("Board panel: surfaces running/needs-attention/done counts and links a needs-attention title to the board", async ({
  page
}) => {
  writeCard("01FIXTUREA", {
    title: "Board panel fixture: in progress",
    list: "implement",
    updated: "2026-07-14T10:00:00Z"
  });
  writeCard("01FIXTUREB", {
    title: "Board panel fixture: needs attention",
    list: "needs-attention",
    attentionReason: "fixture reason",
    updated: "2026-07-14T11:00:00Z"
  });
  writeCard("01FIXTUREC", { title: "Board panel fixture: done", list: "done" });

  fs.mkdirSync(UI_FITTINGS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(UI_FITTINGS_DIR, "kanban-loop.json"),
    JSON.stringify({ fittingId: "kanban-loop", port: 7089, url: "http://127.0.0.1:7089", route: "/board" })
  );

  await page.goto("/", { timeout: 60_000 });
  const panel = page.locator('.dash-panels [data-testid="board-panel"]');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText("Running");
  await expect(panel).toContainText("Needs attention");
  await expect(panel).toContainText("Done");

  const link = panel.getByRole("link", { name: "Board panel fixture: needs attention" });
  await expect(link).toHaveAttribute("href", "http://127.0.0.1:7089/board");
});
