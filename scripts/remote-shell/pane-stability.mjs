// Pane-stability check: the terminal pane must stay mounted across many idle
// poll ticks (the 10s poll used to remount it every tick).
import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:8083", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".wc-thread-open", { timeout: 20000 });
await page.locator(".wc-thread-open", { hasText: "CSG work" }).first().click();
await page.waitForSelector('[data-testid="remote-shell-pane"] .xterm', { timeout: 30000 });
let gaps = 0;
let checks = 0;
const start = Date.now();
while (Date.now() - start < 50_000) {
  const mounted = await page.locator('[data-testid="remote-shell-pane"] .xterm').count();
  checks++;
  if (mounted === 0) gaps++;
  await page.waitForTimeout(2000);
}
await page.screenshot({ path: "evidence/remote-shell-csg-live/7-stable.png" });
console.log(`checks=${checks} gaps=${gaps} ${gaps === 0 ? "STABLE" : "FLICKERING"}`);
await browser.close();
