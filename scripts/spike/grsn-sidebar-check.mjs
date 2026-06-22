import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
try {
  await page.goto("http://127.0.0.1:7777/", { waitUntil: "domcontentloaded", timeout: 30000 });
} catch (e) {
  console.log("goto soft: " + e.message);
}
await page.waitForTimeout(3000);

const aside = page.locator("aside.side");
await aside.screenshot({ path: "docs/autothing/evidence/refit/s4-sidebar-expanded.png" });

// nav labels present / absent
const navText = await aside.locator("nav.tabs").innerText();
console.log("NAV: " + JSON.stringify(navText.replace(/\n+/g, " | ")));

// footer text
const foot = await aside.locator(".side-foot").innerText().catch(() => "(no foot)");
console.log("FOOT: " + JSON.stringify(foot.replace(/\n+/g, " | ")));

// collapse Quarters
const quartersToggle = aside.locator("button.group-toggle", { hasText: "Quarters" });
await quartersToggle.click();
await page.waitForTimeout(400);
const afterQuartersCollapse = await aside.locator("nav.tabs").innerText();
console.log("AFTER QUARTERS COLLAPSE contains 'Settings'? " + afterQuartersCollapse.includes("Settings"));

// collapse Views
const viewsToggle = aside.locator("button.group-toggle", { hasText: "Views" });
if (await viewsToggle.count()) {
  await viewsToggle.click();
  await page.waitForTimeout(400);
}
await aside.screenshot({ path: "docs/autothing/evidence/refit/s4-sidebar-collapsed.png" });
console.log("done");
await browser.close();
