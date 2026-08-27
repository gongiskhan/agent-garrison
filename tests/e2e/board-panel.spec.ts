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

// The panel's own test id, with no ancestor. It used to be scoped by
// `.dash-panels`, a GLOBAL class the dashboard stopped rendering when its panel
// grid moved to a CSS module (b958983c) - the class survives in globals.css, so
// nothing failed loudly and every test in this file silently matched nothing.
// A test id is unique by construction; pinning it to a styling class only gave
// the selector a second way to go stale.
const BOARD_PANEL = '[data-testid="board-panel"]';

const BOARD_DIR = path.join(GARRISON_SANDBOX, "kanban-loop");
const UI_FITTINGS_DIR = path.join(GARRISON_SANDBOX, "ui-fittings");

function writeCard(id: string, card: Record<string, unknown>): void {
  const dir = path.join(BOARD_DIR, "cards", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "card.json"), JSON.stringify({ id, ...card }));
}

// Wait out Garrison's orphan sweep before any test writes a fixture.
//
// Loading the dashboard calls getRunnerState(), which fires
// reconcileOrphanedOwnPortFittings() FIRE-AND-FORGET (runner.ts). That sweep
// unlinks the status file of every own-port fitting with no live process - and
// kanban-loop is one, so the record these tests fabricate for port 7089 is a
// textbook orphan. The app is right to reap it; the tests were racing it. The
// sweep landing a few ticks after the navigation that triggered it meant it ate
// the NEXT test's fixture, which is why exactly the second test executed failed,
// whichever viewport ran first, while the same test passed alone.
//
// The sweep is memoised per server process, so letting it run once here makes
// every later fixture safe. Waiting for it to eat a sentinel is the signal that
// it has actually completed - a fixed sleep would just move the race.
test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(UI_FITTINGS_DIR, { recursive: true });
  const sentinel = path.join(UI_FITTINGS_DIR, "kanban-loop.json");
  fs.writeFileSync(sentinel, JSON.stringify({ fittingId: "kanban-loop", port: 7089, url: "http://127.0.0.1:7089" }));
  const page = await browser.newPage();
  try {
    await page.goto("/", { timeout: 60_000 });
    const deadline = Date.now() + 30_000;
    // Already-swept servers never delete it; the bounded wait then costs one
    // pass and the fixtures are safe either way.
    while (fs.existsSync(sentinel) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    await page.close();
  }
});

test.afterEach(() => {
  fs.rmSync(BOARD_DIR, { recursive: true, force: true });
  fs.rmSync(UI_FITTINGS_DIR, { recursive: true, force: true });
});

test("Board panel: quiet idle state when the board has nothing running or parked", async ({ page }) => {
  await page.goto("/", { timeout: 60_000 });
  const panel = page.locator(BOARD_PANEL);
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
  const panel = page.locator(BOARD_PANEL);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText("Running");
  await expect(panel).toContainText("Needs attention");
  await expect(panel).toContainText("Done");

  const link = panel.getByRole("link", { name: "Board panel fixture: needs attention" });
  await expect(link).toHaveAttribute("href", "http://127.0.0.1:7089/board");
});

test("Board panel: overflow past the shown titles is a route to the board, not a dead end", async ({
  page
}) => {
  // The panel shows five titles and used to end with a bare "+N more" - naming
  // cards the reader then had no way to reach from here. It stays capped (this
  // is one panel among several, it cannot grow without bound), so the overflow
  // line itself has to be the way through.
  for (let i = 0; i < 8; i++) {
    writeCard(`01OVERFLOW${i}`, {
      title: `Overflow fixture ${i}`,
      list: "needs-attention",
      attentionReason: "fixture reason",
      updated: `2026-07-14T1${i}:00:00Z`
    });
  }

  fs.mkdirSync(UI_FITTINGS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(UI_FITTINGS_DIR, "kanban-loop.json"),
    JSON.stringify({ fittingId: "kanban-loop", port: 7089, url: "http://127.0.0.1:7089", route: "/board" })
  );

  await page.goto("/", { timeout: 60_000 });
  const panel = page.locator(BOARD_PANEL);
  await expect(panel).toBeVisible({ timeout: 30_000 });

  const more = panel.locator('[data-testid="board-attention-more"]');
  await expect(more).toHaveText("+3 more on the board");
  await expect(more).toHaveAttribute("href", "http://127.0.0.1:7089/board");
});

test("Board panel: overflow stays unlinked when no board route exists from here", async ({ page }) => {
  // No ui-fittings record, so there is no address that works for whoever opened
  // this page. A link would be worse than none: on a remote browser it resolves
  // to that machine's own 127.0.0.1.
  for (let i = 0; i < 7; i++) {
    writeCard(`01NOROUTE${i}`, {
      title: `No-route fixture ${i}`,
      list: "needs-attention",
      updated: `2026-07-14T1${i}:00:00Z`
    });
  }

  await page.goto("/", { timeout: 60_000 });
  const panel = page.locator(BOARD_PANEL);
  await expect(panel).toBeVisible({ timeout: 30_000 });

  const more = panel.locator('[data-testid="board-attention-more"]');
  await expect(more).toHaveText("+2 more");
  await expect(more).not.toHaveAttribute("href", /./);
});
