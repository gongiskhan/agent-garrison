import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://127.0.0.1:8083", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1500);
await p.locator(".wc-rsh-entry", { hasText: "CSG work" }).first().click();
await p.waitForSelector('[data-testid="remote-shell-pane"] .xterm-screen', { timeout: 30000 });
await p.waitForTimeout(3000);
console.log(await p.evaluate(() => {
  const d = document.querySelector(".wc-wb-delegate");
  const classes = new Set();
  d.querySelectorAll("*").forEach((el) => el.classList.forEach((c) => classes.add(c)));
  const turns = [...d.querySelectorAll(".cc-turn")].slice(-3).map((t) => t.textContent.trim().slice(0, 200));
  return { classes: [...classes].sort(), lastTurns: turns, state: document.querySelector(".wc-workbench")?.dataset?.state };
}));
await b.close();
