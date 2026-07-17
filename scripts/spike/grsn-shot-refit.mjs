import { chromium } from "playwright";

const base = "http://127.0.0.1:27777";
const jobs = process.argv.slice(2).map((a) => {
  const i = a.lastIndexOf("::");
  return { route: a.slice(0, i), out: a.slice(i + 2) };
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
for (const { route, out } of jobs) {
  try {
    await page.goto(base + route, { waitUntil: "networkidle", timeout: 30000 });
  } catch (e) {
    console.log(`goto ${route} soft-timeout: ${e.message}`);
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: out, fullPage: true });
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => "");
  console.log(`shot ${route} -> ${out}\n  firstText: ${JSON.stringify(txt.slice(0, 160))}`);
}
await browser.close();
