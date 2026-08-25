import { chromium } from "@playwright/test";
const OUT = "/home/ggomes/dev/garrison/evidence/mesh-final";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

// 7: the roster with OPEN buttons, tight and unambiguous
await page.goto("http://127.0.0.1:8777/mesh", { waitUntil: "networkidle", timeout: 90000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/16-roster-open-buttons.png` });

// 6: the PRO presses Pull; expect a CLEAN result (dev-madrid replied/merged, no error rows)
await page.goto("http://127.0.0.1:18801/mesh", { waitUntil: "networkidle", timeout: 90000 });
await page.waitForTimeout(3000);
await page.locator("select").last().selectOption("garrison");
await page.getByRole("button", { name: /Pull mesh into this node/i }).click();
await page.waitForSelector("text=/Pull garrison:/i", { timeout: 240000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/17-pro-pull-clean.png`, fullPage: true });
const t = await page.locator("body").innerText();
console.log(t.match(/Pull garrison:[^\n]*/)?.[0]);
for (const line of t.split("\n")) if (/replied|no-reply|merged|error|failed/.test(line) && /goncalos|dev-madrid/.test(line)) console.log(" ", line.trim().slice(0, 140));
await browser.close();
