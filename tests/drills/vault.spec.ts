// AUTO-EMITTED by Drill (B8) from a passing vision run. Hand-edit at your
// own risk — the next graduation of any step on this page rewrites this file.
import { test, expect } from "@playwright/test";
import { drillJudge } from "./support/drill-judge";

test.describe("Vault", () => {
  test("ux-functional-smoke: The Vault page communicates security state and empty-state actions clearly; its lifecycle table and controls remain readable and contained at this viewport.", async ({ page }) => {
    // Loaded-machine wait (F9): a batch run shares the machine with other
    // parallel work — a pure timeout here should widen this wait, not be
    // treated as a step defect.
    await page.goto("http://127.0.0.1:7777/vault", { timeout: 90000, waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 90000 }).catch(() => {});
    const ok = await drillJudge(page, "The Vault page communicates security state and empty-state actions clearly; its lifecycle table and controls remain readable and contained at this viewport.");
    expect(ok, "drillJudge: The Vault page communicates security state and empty-state actions clearly; its lifecycle table and controls remain readable and contained at this viewport.").toBe(true);
  });
});
