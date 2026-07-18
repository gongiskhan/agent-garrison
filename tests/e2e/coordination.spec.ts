import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http, { type Server } from "node:http";
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
function agentMailStatusFile(): string {
  return path.join(GARRISON_SANDBOX, "ui-fittings", "coord-agentmail.json");
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
  let agentMail: Server | null = null;

  test.beforeAll(async () => {
    // The post-Beads hero verdict correctly reports DOWN when agent_mail is
    // unavailable. Keep this UI scenario focused on the stale-lock branch by
    // giving the sandbox a real, reachable health endpoint.
    agentMail = http.createServer((req, res) => {
      const status = req.url === "/api/health" ? 200 : 404;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { ok: true } : { error: "not-found" }));
    });
    await new Promise<void>((resolve, reject) => {
      agentMail!.once("error", reject);
      agentMail!.listen(0, "127.0.0.1", resolve);
    });
    const address = agentMail.address();
    if (!address || typeof address === "string") throw new Error("agent_mail test server did not bind a TCP port");
    fs.mkdirSync(path.dirname(agentMailStatusFile()), { recursive: true });
    fs.writeFileSync(
      agentMailStatusFile(),
      JSON.stringify({
        url: `http://127.0.0.1:${address.port}`,
        mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
      })
    );
  });

  test.beforeEach(() => clearLocks());
  test.afterAll(async () => {
    clearLocks();
    fs.rmSync(agentMailStatusFile(), { force: true });
    if (agentMail) {
      await new Promise<void>((resolve, reject) => {
        agentMail!.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

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
