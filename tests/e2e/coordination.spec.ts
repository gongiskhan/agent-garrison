import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { GARRISON_SANDBOX } from "./sandbox";

// Committed e2e for the Coordination view. The dev server runs with
// GARRISON_HOME=GARRISON_SANDBOX (per playwright.config), so seeding coord state
// here drives the real view deterministically without touching the live ~/.garrison.

const DEMO_REPO = "/demo/acme-api";
function slug(repo: string): string {
  return crypto.createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 16);
}
function lockDir(): string {
  return path.join(GARRISON_SANDBOX, "coord", "plan-locks");
}
function seedStaleLock(): void {
  fs.mkdirSync(lockDir(), { recursive: true });
  const past = new Date(Date.now() - 20 * 60000).toISOString();
  fs.writeFileSync(
    path.join(lockDir(), `${slug(DEMO_REPO)}.json`),
    JSON.stringify({ repo: DEMO_REPO, session: "sess-stuckheron", summary: "refactor the billing schema", startedAt: past, heartbeatAt: past, expiresAt: past, ttlMs: 900000 })
  );
}
function clearLocks(): void {
  fs.rmSync(lockDir(), { recursive: true, force: true });
}

test.describe("Coordination view", () => {
  test.beforeEach(() => clearLocks());
  test.afterAll(() => clearLocks());

  test("renders the unified state: hero verdict + all sections + Verify now", async ({ page }) => {
    await page.goto("/coordination");
    // Hero verdict (the one-second answer) always renders with a verdict.
    const hero = page.getByTestId("hero-verdict");
    await expect(hero).toBeVisible();
    await expect(hero).toHaveAttribute("data-verdict", /live-and-used|idle|degraded|down|unknown/);
    // Every section present.
    for (const label of ["Liveness", "Planning gate", "Active sessions", "Recent intents", "File leases", "Hook heartbeat"]) {
      await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Verify now" })).toBeVisible();
  });

  test("a stale planning lock turns the hero verdict degraded + surfaces a guarded Release action", async ({ page }) => {
    seedStaleLock();
    await page.goto("/coordination");
    const hero = page.getByTestId("hero-verdict");
    // Degraded must dominate — a stale lock is unmissable.
    await expect(hero).toHaveAttribute("data-verdict", "degraded");
    await expect(hero).toContainText(/stale planning lock/i);
    // The planning gate shows the stale lock + a Release action.
    await expect(page.getByText("STALE", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Release lock" }).first()).toBeVisible();
  });

  test("Verify now runs the PTY-safe canary and shows a result", async ({ page }) => {
    await page.goto("/coordination");
    await page.getByRole("button", { name: "Verify now" }).click();
    // A result banner appears (pass or fail) — the action ran end to end.
    await expect(page.locator(".banner").first()).toBeVisible({ timeout: 30000 });
  });
});
