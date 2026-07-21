// Playwright CLI test: screen-share session closes and stays closed.
// Run: playwright test scripts/test-screen-share-close.mjs --browser chromium
//
// Requires the Garrison dev server to be running at http://127.0.0.1:27777

// Headless-gap fix (S16/E11): resolve playwright from the repo, not a hardcoded Mac nvm path.
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:27777";
const POLL_WAIT_MS = 2500; // longer than the 1s session poll, confirm it doesn't come back

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // ── 0. Reset server state and stale lock so we start clean ──────────────
  const { execSync } = await import("node:child_process");
  try {
    execSync("rm -f /tmp/garrison-screen-running.lock");
  } catch {
    // ignore if already absent
  }
  await fetch(`${BASE}/api/trenches/screen-share`, { method: "DELETE" }).catch(() => null);

  // ── 1. Navigate to Trenches ───────────────────────────────────────────────
  await page.goto(`${BASE}/trenches`, { waitUntil: "networkidle" });
  console.log("✓ loaded /trenches");

  // ── 2. Confirm no screen-share session exists yet ─────────────────────────
  await page.waitForTimeout(1500); // let the 1s poll settle
  const beforeCount = await page.locator("text=screen-share").count();
  if (beforeCount > 0) {
    // a stale session survived — this shouldn't happen after lock removal above
    throw new Error(`Expected 0 screen-share sessions before start, found ${beforeCount}`);
  }
  console.log("✓ no stale screen-share session present");

  // ── 3. Start a screen share ───────────────────────────────────────────────
  const startBtn = page.getByRole("button", { name: /New Screen Share/i });
  await startBtn.click();

  // Wait for the session to appear in the sidebar
  await page.waitForSelector("text=screen-share", { timeout: 8000 });
  console.log("✓ screen-share session appeared in sidebar");

  // ── 4. Close the session via the X button ─────────────────────────────────
  // The X button is next to the "screen-share" entry in the sidebar
  const sessionRow = page.locator(".trenches-tab", { hasText: "screen-share" });
  await sessionRow.waitFor({ state: "visible" });
  const closeBtn = sessionRow.locator("button[title='Close session']");
  await closeBtn.click();
  console.log("✓ clicked close (X) on screen-share session");

  // ── 5. Wait for it to disappear ───────────────────────────────────────────
  await page.waitForFunction(
    () => !document.body.innerText.includes("screen-share"),
    { timeout: 5000 }
  );
  console.log("✓ screen-share session disappeared from sidebar");

  // ── 6. Confirm it does NOT come back after two poll cycles ────────────────
  await page.waitForTimeout(POLL_WAIT_MS);
  const afterCount = await page.locator(".trenches-tab", { hasText: "screen-share" }).count();
  if (afterCount > 0) {
    throw new Error(
      `BUG: screen-share session came back after ${POLL_WAIT_MS}ms — close-resurrect race not fixed`
    );
  }
  console.log(`✓ session stayed closed for ${POLL_WAIT_MS}ms — bug is fixed`);

  console.log("\nALL CHECKS PASSED");
} finally {
  await browser?.close();
}
