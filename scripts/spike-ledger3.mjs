import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://127.0.0.1:8083", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1500);
await p.locator(".wc-rsh-entry", { hasText: "CSG work" }).first().click();
await p.waitForSelector('[data-testid="remote-shell-pane"] .xterm-screen', { timeout: 30000 });
await p.waitForTimeout(3000);
console.log(await p.evaluate(() => {
  const turns = [...document.querySelectorAll(".wc-wb-delegate .cc-turn")];
  const last = turns[turns.length - 1];
  return {
    user: last?.querySelector(".cc-user")?.textContent?.trim().slice(0, 100),
    code: last?.querySelector("pre code")?.textContent?.slice(-700),
  };
}));
await b.close();
